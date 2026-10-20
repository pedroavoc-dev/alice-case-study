# Security review — what I found and what happened next

In September 2026 I audited the whole system: the active n8n workflows,
the lead dashboards, the edge Worker and the database access paths.

**What is published here.** Only findings whose fix was published *and*
checked from the outside (for example, by replaying the attack). No URLs,
keys or identifiers appear here.

---

## 1. Stored XSS through JSON embedded in an inline script

**What:** the dashboard page was assembled server-side, with the lead rows
embedded like this:

```js
// BEFORE
html = "<script>window.__DATA__=" + JSON.stringify(rows) + ";</script>";
```

`JSON.stringify` does not escape `</script>`. One of the fields is the
WhatsApp profile name, which **the applicant controls completely**. A name
such as `</script><script>…` closes the tag and runs code in the browser
of whoever opens the dashboard, with every lead on the page within reach.
The page did have a correct `esc()` helper — but it ran later, in the
browser, after the injection had already happened.

**Fix:**

```js
// AFTER — escape the characters that can break out of a script block
const safe = JSON.stringify(rows)
  .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
  .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
html = "<script>window.__DATA__=" + safe + ";</script>";

// Even better: no inline data at all. Fetch JSON and render with textContent.
cell.textContent = row.name;   // never innerHTML with user data
```

Also added a `LIMIT` to the query behind it, which had none.
Runnable version with a self-check: [`workflow/safe-json-in-script.js`](workflow/safe-json-in-script.js).

**Status: fixed.** Verified by sending the real payload before and after:
before, the tag broke; after, it did not, and the data rendered unchanged.

---

## 2. Webhook signature validation at the edge

Meta signs every webhook delivery with `X-Hub-Signature-256`, an HMAC of
the raw body with the app secret. Without checking it, anyone who finds the
URL can inject fake messages: burn LLM credits, trigger outbound messages,
fill the database with fake leads or impersonate an applicant.

**What I found:** Meta was not delivering to n8n directly. An undocumented
Cloudflare Worker sat in front of it and **did** validate the signature;
the defence had existed for weeks and nobody knew. Lesson: map the real
request path before declaring a hole.

The Worker compared signatures with a normal string comparison, which can
exit early (timing side channel). The Worker in this repo uses a byte
comparison that always walks the full length:

```js
// BEFORE
if (expectedHex === receivedHex) { ... }          // early-exit comparison

// AFTER — see worker/src/index.js
const key = await crypto.subtle.importKey("raw", enc(appSecret),
  { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
const ok = crypto.subtle.timingSafeEqual(expected, hexToBytes(receivedHex)); // after a length check

// Node equivalent
const a = Buffer.from(received), b = Buffer.from(expected);
const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
```

The version in this repo is tested offline (`worker/test/`).

---

## 3. Personal data in test material

Real conversations are the best test material and the worst thing to leave
lying around. They are anonymised before being used — phone numbers and
emails become stable codes — see [`tools/anonymise.py`](tools/anonymise.py).
