// Sanitized excerpt: the fix for the stored XSS described in SECURITY-REVIEW.md.
//
// The lead dashboard was rendered server-side by an n8n Code node that
// embedded the rows into an inline <script>:
//
//   "<script>window.__LEADS__=" + JSON.stringify(rows) + ";</script>"
//
// JSON.stringify does NOT escape "</script>". The WhatsApp profile name is
// fully controlled by the applicant, so a name containing
// "</script><script>...</script>" closes the tag and runs code in the browser
// of whoever opens the dashboard, with access to every lead on the page.
// The dashboard's own esc() helper was correct, but it ran later, in the
// browser — after the injection had already happened.
//
// Run: node safe-json-in-script.js

function jsonForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// --- self-check with a fake malicious row ------------------------------------
const assert = require("node:assert/strict");

const rows = [{ name: "</script><script>alert(1)</script>", stage: "new" }];

const before = "<script>window.__LEADS__=" + JSON.stringify(rows) + ";</script>";
const after = "<script>window.__LEADS__=" + jsonForInlineScript(rows) + ";</script>";

// Before: the payload closes the script tag early (2 closing tags + the real one).
assert.equal((before.match(/<\/script>/g) || []).length, 3);
// After: only the real closing tag remains...
assert.equal((after.match(/<\/script>/g) || []).length, 1);
// ...and the data is identical once parsed.
const inner = after.slice("<script>window.__LEADS__=".length, -";</script>".length);
assert.deepEqual(JSON.parse(inner), rows);

console.log("safe-json-in-script: ok");
module.exports = { jsonForInlineScript };
