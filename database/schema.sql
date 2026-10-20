-- ============================================================
-- Alice — WhatsApp AI agent for driver-applicant qualification
-- Postgres schema (sanitized excerpt of the original design)
--
-- Runs on any Postgres 13+ (the project used a managed Postgres).
-- No data, no credentials. Column names were translated to English.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------
-- 1) CONTACTS — one row per WhatsApp number
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wa_id           TEXT UNIQUE NOT NULL,        -- E.164 digits without '+' (personal data: never log it)
    profile_name    TEXT,                        -- WhatsApp profile name: USER-CONTROLLED, escape on output
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 2) CONVERSATIONS — live state, the heart of the human handoff
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id          UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    ai_paused           BOOLEAN NOT NULL DEFAULT false,   -- true = a human owns the conversation
    assigned_human      TEXT,                             -- handle of the person who took over
    lead_stage          TEXT NOT NULL DEFAULT 'new',      -- new|qualifying|hot|handoff|closed|lost
    language            TEXT,                             -- detected language code, e.g. 'en'
    summary             TEXT,                             -- rolling summary to save tokens
    last_ai_confidence  NUMERIC(3,2),
    paused_at           TIMESTAMPTZ,                      -- when the handoff happened
    last_human_at       TIMESTAMPTZ,                      -- last human action
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_conversation_contact UNIQUE (contact_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_paused ON conversations(ai_paused);
CREATE INDEX IF NOT EXISTS idx_conv_stage  ON conversations(lead_stage);

-- ------------------------------------------------------------
-- 3) MESSAGES — full history (the agent's memory)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,               -- user | ai | human | system
    content         TEXT,
    wa_message_id   TEXT,                        -- WhatsApp message id
    msg_type        TEXT DEFAULT 'text',         -- text|audio|image|document|...
    tokens          INTEGER,                     -- to track LLM cost
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

-- ------------------------------------------------------------
-- 4) LEADS — structured qualification
--    Only what the triage needs. No ID numbers, no bank details,
--    no address, no date of birth: data minimisation (GDPR art. 5).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    contact_id          UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    has_licence         BOOLEAN,                 -- holds a driving licence
    licence_years       TEXT,                    -- free text, e.g. '3 years'
    has_platform_permit BOOLEAN,                 -- holds the local permit required to drive for platforms
    vehicle             TEXT,                    -- own | fleet_rental | undecided
    availability        TEXT,                    -- full-time | part-time | hours/week
    area                TEXT,                    -- city / region the applicant wants to work in
    start_when          TEXT,                    -- when they can start
    callback_at         TIMESTAMPTZ,             -- requested call-back slot
    score               INTEGER NOT NULL DEFAULT 0,  -- 0-100, rises with qualification/intent
    notes               TEXT,                    -- USER-INFLUENCED text: escape on output
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_lead_conversation UNIQUE (conversation_id)
);

-- ------------------------------------------------------------
-- 5) MESSAGE BUFFER — debounce for people who send 3 messages in a row
--    See workflow/message-buffer.sql for how it is consumed atomically.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_buffer (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wa_id           TEXT NOT NULL,
    content         TEXT,
    wa_message_id   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed        BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_buffer_wa ON message_buffer(wa_id, created_at);

-- ------------------------------------------------------------
-- 6) IDEMPOTENCY — Meta retries webhooks; process each message once
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processed_messages (
    wa_message_id   TEXT PRIMARY KEY,
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 7) ERROR LOG
--    Lesson: in production this table stayed empty for weeks because
--    NOTHING wrote to it — the global error workflow only sent a chat
--    alert. A table is not monitoring; a writer is.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS error_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node            TEXT,
    message         TEXT,
    payload         JSONB,                       -- do not store raw message bodies here
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- updated_at trigger
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contacts_updated ON contacts;
CREATE TRIGGER trg_contacts_updated BEFORE UPDATE ON contacts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_conv_updated ON conversations;
CREATE TRIGGER trg_conv_updated BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_leads_updated ON leads;
CREATE TRIGGER trg_leads_updated BEFORE UPDATE ON leads
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- Monitoring views (aggregates only, no personal data)
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_daily_metrics AS
SELECT date_trunc('day', m.created_at) AS day,
       count(*) FILTER (WHERE m.role='user')  AS msgs_applicant,
       count(*) FILTER (WHERE m.role='ai')    AS msgs_ai,
       count(*) FILTER (WHERE m.role='human') AS msgs_human,
       coalesce(sum(m.tokens),0)              AS tokens_total
FROM messages m
GROUP BY 1 ORDER BY 1 DESC;

CREATE OR REPLACE VIEW v_pipeline AS
SELECT lead_stage, count(*) AS total
FROM conversations GROUP BY 1;
