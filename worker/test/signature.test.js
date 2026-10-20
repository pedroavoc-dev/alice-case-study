// Offline test of the gateway's request handling. No network: fetch is stubbed.
// Run: node test/signature.test.js   (Node 18+)
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker, { verifyMetaSignature, safeEqual } from "../src/index.js";

const SECRET = "test-app-secret-not-real";
const body = JSON.stringify({
  entry: [{ changes: [{ value: { messages: [{ from: "test-sender", id: "wamid.TEST", type: "text", text: { body: "hello" } }] } }] }],
});
const sign = (b, s = SECRET) => "sha256=" + createHmac("sha256", s).update(b).digest("hex");
const bytes = new TextEncoder().encode(body);

// --- verifyMetaSignature ---------------------------------------------------
assert.equal(await verifyMetaSignature(bytes, sign(body), SECRET), true, "valid signature");
assert.equal(await verifyMetaSignature(bytes, sign(body, "wrong"), SECRET), false, "wrong secret");
assert.equal(await verifyMetaSignature(bytes, sign(body + " "), SECRET), false, "tampered body");
assert.equal(await verifyMetaSignature(bytes, "", SECRET), false, "missing header");
assert.equal(await verifyMetaSignature(bytes, "sha256=zz", SECRET), false, "malformed header");
assert.equal(await verifyMetaSignature(bytes, sign(body), ""), false, "no secret configured");

// --- safeEqual -------------------------------------------------------------
assert.equal(safeEqual("abc", "abc"), true);
assert.equal(safeEqual("abc", "abd"), false);
assert.equal(safeEqual("abc", "abcd"), false);

// --- fetch handler -----------------------------------------------------------
const forwarded = [];
globalThis.fetch = async (url, init) => {
  forwarded.push({ url: String(url), init });
  return new Response("ok", { status: 200 });
};
const env = { META_APP_SECRET: SECRET, VERIFY_TOKEN: "verify-me", N8N_WEBHOOK_URL: "https://n8n.example.invalid/webhook/test" };
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };

const post = (sig) =>
  new Request("https://gateway.example.invalid/", { method: "POST", body, headers: sig ? { "x-hub-signature-256": sig } : {} });

let r = await worker.fetch(post(null), env, ctx);
assert.equal(r.status, 403, "unsigned POST is rejected");
r = await worker.fetch(post(sign(body, "attacker")), env, ctx);
assert.equal(r.status, 403, "badly signed POST is rejected");
assert.equal(pending.length, 0, "nothing forwarded for rejected requests");

r = await worker.fetch(post(sign(body)), env, ctx);
assert.equal(r.status, 200, "signed POST is accepted");
await Promise.all(pending);
assert.equal(forwarded.length, 1, "signed POST is forwarded to n8n");
assert.equal(forwarded[0].init.body, body, "body forwarded byte-for-byte");

r = await worker.fetch(new Request("https://gateway.example.invalid/?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42"), env, ctx);
assert.equal(r.status, 200);
assert.equal(await r.text(), "42");
r = await worker.fetch(new Request("https://gateway.example.invalid/?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42"), env, ctx);
assert.equal(r.status, 403);

console.log("worker tests: all passed");
