-- Assistant schema: AI suggestions awaiting human approval.
-- Runs automatically on a FRESH postgres volume (docker-entrypoint-initdb.d).
-- Existing volume? Apply manually (idempotent):
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < docker/postgres/init/01-assistant.sql

CREATE SCHEMA IF NOT EXISTS assistant;

CREATE TABLE IF NOT EXISTS assistant.proposals (
    id          bigserial PRIMARY KEY,
    chat_id     text        NOT NULL,
    kind        text        NOT NULL CHECK (kind IN ('calendar_event')),
    payload     jsonb       NOT NULL,          -- exactly what gets executed on approval
    summary     text        NOT NULL,          -- exactly what the user saw on the card
    status      text        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'declined', 'expired', 'executed', 'failed')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL DEFAULT now() + interval '12 hours',
    decided_at  timestamptz,
    result      jsonb                          -- event id/link, or error
);

CREATE INDEX IF NOT EXISTS proposals_chat_status_idx
    ON assistant.proposals (chat_id, status, expires_at);

-- Handy audit view: what did I approve / decline lately?
CREATE OR REPLACE VIEW assistant.decision_log AS
SELECT id, kind, status, summary, created_at, decided_at, result
  FROM assistant.proposals
 ORDER BY created_at DESC;
