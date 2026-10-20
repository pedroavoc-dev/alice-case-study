-- Sanitized excerpt: the three queries around every inbound message.
-- In production each one is a Postgres node in n8n with $1/$2/$3
-- parameters bound from the parsed payload (never string-concatenated).

-- 1) IDEMPOTENCY — Meta may deliver the same webhook more than once.
--    If the message was already seen, no row comes back and the
--    workflow stops here. One statement, no read-then-write race.
INSERT INTO processed_messages (wa_message_id)
VALUES ($1)
ON CONFLICT (wa_message_id) DO NOTHING
RETURNING wa_message_id;

-- 2) BUFFER — people send "hi" / "I saw the ad" / "is it still open?"
--    as three messages in four seconds. Each one goes into the buffer...
INSERT INTO message_buffer (wa_id, content, wa_message_id)
VALUES ($1, $2, $3)
RETURNING id, created_at;

-- ...then the execution waits ~7 seconds (n8n Wait node), and tries to
-- CONSUME everything pending for that number in ONE atomic statement.
-- Whoever arrives first takes all the messages; the other executions
-- get n = 0 and stop without answering. Result: one reply to the whole
-- burst instead of three replies talking over each other.
WITH c AS (
  UPDATE message_buffer
     SET consumed = true
   WHERE wa_id = $1
     AND consumed = false
  RETURNING content, created_at
)
SELECT
  string_agg(content, E'\n' ORDER BY created_at) AS merged,  -- the burst, in order
  count(*)::int                                  AS n        -- 0 = someone else answers
FROM c;
