// Sanitized excerpt, rewritten as a standalone file with fake data.
//
// The model is allowed to "think in parts": it separates paragraphs with
// "|||". The send step joins those parts into ONE WhatsApp message with
// blank lines between them, instead of sending up to three messages.
//
// Why: outbound WhatsApp messages are priced per message, so the rule is
// "fewer messages, never more". There was a node in the workflow that
// split replies into separate bubbles; it is disconnected on purpose.
// If a reply looks like a wall of text, the fix is to write less, not to
// split it.
//
// Run: node single-message.js

function toSingleMessage(modelOutput) {
  return String(modelOutput || "")
    .split("|||")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

function whatsappTextPayload(to, modelOutput) {
  return {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: toSingleMessage(modelOutput) },
  };
}

// --- self-check with fake data ---------------------------------------------
const assert = require("node:assert/strict");

const fake = "Hi! I'm Alice, from the fleet. ||| Do you already hold a driving licence?";
const payload = whatsappTextPayload("<recipient-id>", fake);
assert.equal(payload.text.body, "Hi! I'm Alice, from the fleet.\n\nDo you already hold a driving licence?");
assert.equal(toSingleMessage(""), "");
assert.equal(toSingleMessage("one part only"), "one part only");
assert.equal(toSingleMessage("a ||| ||| b"), "a\n\nb");

console.log("single-message: ok");
module.exports = { toSingleMessage, whatsappTextPayload };
