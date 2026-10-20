/**
 * Alice edge gateway (Cloudflare Worker)
 * --------------------------------------
 * Sits IN FRONT of n8n. The WhatsApp Cloud API webhook points here, not at n8n.
 *
 *  1. GET  -> answers Meta's webhook verification handshake.
 *  2. POST -> verifies Meta's X-Hub-Signature-256 (HMAC-SHA256 of the raw body)
 *             and drops anything that is not signed with the app secret.
 *  3. Forwards the verified body to n8n.
 *       n8n up   -> normal path, the agent answers.
 *       n8n down -> sends the applicant a short holding reply, alerts a human
 *                   on Telegram (no phone number in the alert) and queues the
 *                   body in KV so a cron can replay it when n8n is back.
 *  4. Always answers 200 to *signed* deliveries, so Meta never disables the
 *     webhook because of a backend outage.
 *
 * Sanitized excerpt for a public case study. All secrets are env bindings;
 * nothing sensitive lives in this file. See wrangler.toml.example.
 *
 * Bindings
 *   secrets : META_APP_SECRET, VERIFY_TOKEN, WHATSAPP_TOKEN,
 *             TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, N8N_WEBHOOK_URL,
 *             GATEWAY_SHARED_SECRET (optional)
 *   vars    : PHONE_NUMBER_ID, N8N_TIMEOUT_MS, GRAPH_API_VERSION,
 *             REPLAY_MAX_ATTEMPTS
 *   kv      : ALICE_QUEUE
 */

const HOLDING_REPLY =
  "Got your message! Someone from our team will get back to you shortly. Thanks for your patience.";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1) Webhook verification handshake (GET from Meta)
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token") || "";
      const challenge = url.searchParams.get("hub.challenge") || "";
      if (mode === "subscribe" && env.VERIFY_TOKEN && safeEqual(token, env.VERIFY_TOKEN)) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("forbidden", { status: 403 });
    }

    // 2) Message deliveries (POST from Meta)
    if (request.method === "POST") {
      // Read the RAW bytes: the signature is over the exact body Meta sent,
      // not over a re-serialised JSON object.
      const raw = new Uint8Array(await request.arrayBuffer());
      const signature = request.headers.get("x-hub-signature-256") || "";

      const valid = await verifyMetaSignature(raw, signature, env.META_APP_SECRET);
      if (!valid) {
        // Fail CLOSED at the edge: Meta always signs, so an unsigned or
        // badly signed request is not Meta.
        return new Response("forbidden", { status: 403 });
      }

      const bodyText = new TextDecoder().decode(raw);
      // Answer Meta immediately; do the slow work in the background.
      ctx.waitUntil(handleMessage(bodyText, env));
      return new Response("OK", { status: 200 });
    }

    return new Response("method not allowed", { status: 405 });
  },

  // Cron: replays messages that were queued while n8n was down.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(replayQueue(env));
  },
};

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verifies "sha256=<hex>" against HMAC-SHA256(rawBody, appSecret).
 *
 * The comparison does not use `===` on hex strings (which can return early
 * on the first different character). The expected MAC is computed, and both
 * byte arrays are compared with crypto.subtle.timingSafeEqual when the
 * runtime provides it (Cloudflare Workers does), otherwise with an explicit
 * XOR loop that always walks the full length.
 */
export async function verifyMetaSignature(rawBytes, header, appSecret) {
  if (!appSecret || typeof header !== "string") return false;
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!match) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBytes));
  return bytesEqual(expected, hexToBytes(match[1]));
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  if (crypto.subtle && typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/**
 * Constant-time string comparison for short secrets (verify token).
 * Length is not secret here; the content is.
 */
export function safeEqual(a, b) {
  return bytesEqual(new TextEncoder().encode(String(a)), new TextEncoder().encode(String(b)));
}

// ---------------------------------------------------------------------------
// Forwarding and failover
// ---------------------------------------------------------------------------

async function handleMessage(bodyText, env) {
  const timeout = parseInt(env.N8N_TIMEOUT_MS || "6000", 10);

  if (await forwardToN8n(bodyText, env, timeout)) return; // normal path

  // ---- FAILOVER: n8n unavailable ----
  const parsed = extractMessage(bodyText);
  if (!parsed) return; // status callbacks etc. — nothing to answer

  // Meta retries deliveries. Only alert / reply once per message id.
  const seenKey = `seen:${parsed.waMessageId}`;
  if (parsed.waMessageId && (await env.ALICE_QUEUE.get(seenKey))) return;
  if (parsed.waMessageId) {
    await env.ALICE_QUEUE.put(seenKey, "1", { expirationTtl: 86400 });
  }

  // a) holding reply to the applicant (inside the customer-service window)
  await sendWhatsApp(parsed.from, HOLDING_REPLY, env);

  // b) alert a human — a short reference, never the phone number:
  //    the alert channel is a group, and groups keep history.
  const ref = await shortRef(parsed.from);
  await sendTelegram(
    `AGENT OFFLINE - answer manually\nRef: ${ref}\nType: ${parsed.type}\n` +
      `Open the WhatsApp Business inbox to reply.`,
    env
  );

  // c) queue for replay when n8n is back (24h TTL caps the damage)
  const key = `msg:${Date.now()}:${parsed.waMessageId || crypto.randomUUID()}`;
  await env.ALICE_QUEUE.put(key, bodyText, {
    expirationTtl: 86400,
    metadata: { attempts: 0 },
  });
}

async function forwardToN8n(bodyText, env, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { "content-type": "application/json" };
  // Defence in depth: a shared header the origin can require.
  if (env.GATEWAY_SHARED_SECRET) headers["x-gateway-secret"] = env.GATEWAY_SHARED_SECRET;
  try {
    const r = await fetch(env.N8N_WEBHOOK_URL, {
      method: "POST",
      headers,
      body: bodyText,
      signal: ctrl.signal,
    });
    return r.ok;
  } catch (err) {
    console.log("n8n forward failed:", err && err.name);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function extractMessage(bodyText) {
  try {
    const b = JSON.parse(bodyText);
    const value = (b && b.entry && b.entry[0] && b.entry[0].changes &&
      b.entry[0].changes[0] && b.entry[0].changes[0].value) || {};
    const m = value.messages && value.messages[0];
    if (!m) return null;
    return { from: m.from, waMessageId: m.id, type: m.type || "unknown" };
  } catch (_) {
    return null;
  }
}

async function shortRef(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].slice(0, 4).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function sendWhatsApp(to, text, env) {
  const version = env.GRAPH_API_VERSION || "v21.0";
  try {
    const r = await fetch(`https://graph.facebook.com/${version}/${env.PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    });
    if (!r.ok) console.log("whatsapp send failed:", r.status);
  } catch (err) {
    console.log("whatsapp send error:", err && err.name);
  }
}

async function sendTelegram(text, env) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    });
    if (!r.ok) console.log("telegram send failed:", r.status);
  } catch (err) {
    console.log("telegram send error:", err && err.name);
  }
}

// Replays queued bodies to n8n, oldest first. Stops at the first failure
// (n8n still down) and gives up on a message after REPLAY_MAX_ATTEMPTS.
async function replayQueue(env) {
  const timeout = parseInt(env.N8N_TIMEOUT_MS || "6000", 10);
  const maxAttempts = parseInt(env.REPLAY_MAX_ATTEMPTS || "30", 10);
  const list = await env.ALICE_QUEUE.list({ prefix: "msg:" });

  for (const k of list.keys) {
    const body = await env.ALICE_QUEUE.get(k.name);
    if (!body) continue;

    if (await forwardToN8n(body, env, timeout)) {
      await env.ALICE_QUEUE.delete(k.name);
      continue;
    }

    const attempts = ((k.metadata && k.metadata.attempts) || 0) + 1;
    // KV rejects an absolute expiration less than 60 s ahead: drop instead.
    const nearlyExpired = k.expiration && k.expiration - Date.now() / 1000 < 90;
    if (attempts >= maxAttempts || nearlyExpired) {
      await env.ALICE_QUEUE.delete(k.name);
      await sendTelegram(`Replay gave up on a queued message after ${attempts} attempts.`, env);
    } else {
      // Keep the ORIGINAL expiry, so retries never extend a message's life.
      const keep = k.expiration ? { expiration: k.expiration } : { expirationTtl: 86400 };
      await env.ALICE_QUEUE.put(k.name, body, { ...keep, metadata: { attempts } });
    }
    break; // n8n still down — try again on the next cron tick
  }
}
