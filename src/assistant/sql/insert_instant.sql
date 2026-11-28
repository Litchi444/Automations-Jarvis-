-- Instant task action: a task_add / task_done the user asked for in their own message
-- (gate in parse_agent_output.js). Logged as already approved, so the same
-- mark_executed / mark_failed path runs, and claim_undo.sql can reverse it for 24 h.
-- $1 = chat id, $2 = kind, $3 = payload, $4 = summary. Any other kind inserts nothing.
INSERT INTO assistant.proposals (chat_id, kind, payload, summary, status, decided_at, expires_at, instant)
SELECT $1, $2, $3::jsonb, $4, 'approved', now(), now(), true
 WHERE $2::text IN ('task_add', 'task_done')
RETURNING id, chat_id, kind, payload, summary;
