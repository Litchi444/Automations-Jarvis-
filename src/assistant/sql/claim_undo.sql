-- Atomic: only ONE tap can undo an instant task action, and only within 24 hours.
-- $1 = proposal id, $2 = chat id
-- The inverse runs on the STORED result (the task id Google returned), never on agent output.
WITH claimed AS (
    UPDATE assistant.proposals
       SET status = 'undone'
     WHERE id = $1::bigint AND chat_id = $2::text
       AND status = 'executed' AND instant
       AND kind IN ('task_add', 'task_done')
       AND decided_at > now() - interval '24 hours'
    RETURNING id, kind, payload, result, summary, status, true AS ok
)
SELECT * FROM claimed
UNION ALL
-- Not undoable (already undone, too old, failed, or lost a concurrent race): report the current row.
SELECT id, kind, payload, result, summary, status, false AS ok
  FROM assistant.proposals
 WHERE id = $1::bigint AND chat_id = $2::text
   AND NOT EXISTS (SELECT 1 FROM claimed);
