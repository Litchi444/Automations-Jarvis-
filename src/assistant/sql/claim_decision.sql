-- Atomic: only ONE tap can move a proposal out of 'pending'.
-- $1 = proposal id, $2 = 'approve' | 'decline', $3 = chat id
-- A tap on a stale card marks it 'expired' (ok = false) instead of deciding it.
WITH claimed AS (
    UPDATE assistant.proposals
       SET status = CASE WHEN expires_at <= now() THEN 'expired'
                         WHEN $2::text = 'approve' THEN 'approved'
                         ELSE 'declined' END,
           decided_at = now()
     WHERE id = $1::bigint AND chat_id = $3::text
       AND status = 'pending'
    RETURNING id, kind, payload, summary, status, status <> 'expired' AS ok
)
SELECT * FROM claimed
UNION ALL
-- Not claimable (already decided, or lost a concurrent race): report the current row.
SELECT id, kind, payload, summary, status, false AS ok
  FROM assistant.proposals
 WHERE id = $1::bigint AND chat_id = $3::text
   AND NOT EXISTS (SELECT 1 FROM claimed);
