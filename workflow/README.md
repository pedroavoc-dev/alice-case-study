# workflow/ — sanitized excerpts

**The production n8n workflows are not published.** They contain
credential references, account identifiers and business details that do not
belong in a public repository, and a full export would not run without them
anyway.

What is here instead: small pieces rewritten as standalone files with fake
data, chosen because each one illustrates a decision explained in the main
README.

| File | What it shows |
|---|---|
| `message-buffer.sql` | Idempotency (Meta retries deliveries) and the debounce buffer: one reply to a burst of messages, consumed atomically. |
| `single-message.js` | The model writes in parts separated by `\|\|\|`; the send step joins them into one WhatsApp message. Cost decision. |
| `safe-json-in-script.js` | The stored-XSS fix for the lead dashboard: escaping JSON before embedding it in an inline `<script>`. |

Run the JS files with Node 18+ (`node single-message.js`); each one
asserts its own behaviour and prints `ok`.

## Shape of the main workflow (described, not exported)

About 50 nodes in the version that was reviewed. In order:

1. Webhook (POST) receives what the edge Worker forwarded.
2. Signature check (second layer, see SECURITY-REVIEW.md) and payload parsing.
3. Idempotency insert, then upsert contact + conversation.
4. If a human owns the conversation (`ai_paused`): store the message, ping
   the human, stop.
5. Audio? Fetch media, transcribe, continue as text.
6. Buffer insert, wait ~7 s, atomic consume (only the last execution
   answers).
7. Load what is already known about the lead; deterministic language
   detection (word lists, no AI).
8. AI agent (OpenAI chat model + Postgres chat memory) with a structured
   output parser: `{ action: reply | handoff | ignore, message, lead_update,
   language, confidence, handoff_reason }`.
9. Router on `action`: send reply / mark handoff and alert humans / do
   nothing. A fallback branch sends a safe holding message and alerts if
   the model output cannot be parsed.
10. Store the lead fields; if the lead became "hot", alert the team once.
