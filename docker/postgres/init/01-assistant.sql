-- Assistant schema: AI suggestions awaiting human approval.
-- Runs automatically on a FRESH postgres volume (docker-entrypoint-initdb.d).
-- Existing volume? Apply manually (idempotent). Uses the copy mounted in the container,
-- so it works from bash and PowerShell (PowerShell has no '<' input redirection):
--   docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/01-assistant.sql'

CREATE SCHEMA IF NOT EXISTS assistant;

CREATE TABLE IF NOT EXISTS assistant.proposals (
    id          bigserial PRIMARY KEY,
    chat_id     text        NOT NULL,
    kind        text        NOT NULL,          -- allowed values: proposals_kind_check below
    payload     jsonb       NOT NULL,          -- exactly what gets executed on approval
    summary     text        NOT NULL,          -- exactly what the user saw on the card
    status      text        NOT NULL DEFAULT 'pending', -- allowed values: proposals_status_check below
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL DEFAULT now() + interval '12 hours',
    decided_at  timestamptz,
    result      jsonb                          -- event id/link, or error
);

-- Kept outside CREATE TABLE so an existing volume picks up new kinds / statuses on re-apply.
-- Instant rows (instant = true): task_add / task_done the user asked for in their own message,
-- run without a tap and undoable for 24 h ('undone'). Everything else needs a tap.
ALTER TABLE assistant.proposals ADD COLUMN IF NOT EXISTS instant boolean NOT NULL DEFAULT false;
ALTER TABLE assistant.proposals DROP CONSTRAINT IF EXISTS proposals_kind_check;
ALTER TABLE assistant.proposals ADD CONSTRAINT proposals_kind_check CHECK (kind IN
    ('calendar_event', 'event_move', 'event_delete', 'task_add', 'task_done', 'task_delete'));
ALTER TABLE assistant.proposals DROP CONSTRAINT IF EXISTS proposals_status_check;
ALTER TABLE assistant.proposals ADD CONSTRAINT proposals_status_check CHECK (status IN
    ('pending', 'approved', 'declined', 'expired', 'executed', 'failed', 'undone'));
ALTER TABLE assistant.proposals DROP CONSTRAINT IF EXISTS proposals_instant_check;
ALTER TABLE assistant.proposals ADD CONSTRAINT proposals_instant_check
    CHECK (NOT instant OR kind IN ('task_add', 'task_done'));

CREATE INDEX IF NOT EXISTS proposals_chat_status_idx
    ON assistant.proposals (chat_id, status, expires_at);

-- Read-only copy of the university mailbox (filled by the "University mail → database" workflow).
-- The agent can only SELECT from it through fixed, parameterized queries.
CREATE TABLE IF NOT EXISTS assistant.uni_emails (
    id          bigserial PRIMARY KEY,
    message_id  text        NOT NULL UNIQUE,   -- Message-ID header: makes re-delivery idempotent
    from_addr   text        NOT NULL DEFAULT '',
    to_addr     text        NOT NULL DEFAULT '',
    subject     text        NOT NULL DEFAULT '',
    body        text        NOT NULL DEFAULT '', -- plain text, capped at 20k chars
    received_at timestamptz NOT NULL,
    fetched_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS uni_emails_received_idx
    ON assistant.uni_emails (received_at DESC);

-- Writing guides ("skills") the agent can look up when asked to write something.
-- Source of truth: skills/*.md in the repo, loaded by the generated 02-skills.sql.
-- The agent can only SELECT from it through fixed, parameterized queries.
CREATE TABLE IF NOT EXISTS assistant.skills (
    name        text        PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    description text        NOT NULL,
    body        text        NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Answer styles: how Jarvis talks to the user (tone, length, personality).
-- Source of truth: styles/*.md in the repo, loaded by the generated 03-styles.sql.
-- 'off' is reserved: "/style off" goes back to the default.
CREATE TABLE IF NOT EXISTS assistant.styles (
    name        text        PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,62}$' AND name <> 'off'),
    description text        NOT NULL,
    body        text        NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The style chosen per chat. Written ONLY by the "/style" command node (plain workflow
-- node, never the agent). Deleting a style from styles/ resets chats using it to default.
CREATE TABLE IF NOT EXISTS assistant.chat_settings (
    chat_id     text        PRIMARY KEY,
    style       text        REFERENCES assistant.styles (name) ON DELETE SET NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Agent chat memory. n8n's "Chat memory" node creates this same table on its first run;
-- created here too so "Trim chat memory" never runs against a missing table.
CREATE TABLE IF NOT EXISTS public.assistant_chat_history (
    id          SERIAL       PRIMARY KEY,
    session_id  VARCHAR(255) NOT NULL,
    message     JSONB        NOT NULL
);

-- Handy audit view: what did I approve / decline lately?
CREATE OR REPLACE VIEW assistant.decision_log AS
SELECT id, kind, status, summary, created_at, decided_at, result, instant
  FROM assistant.proposals
 ORDER BY created_at DESC;
