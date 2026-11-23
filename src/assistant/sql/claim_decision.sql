-- Atomic: only ONE tap can move a proposal out of 'pending'.
-- $1 = proposal id, $2 = 'approve' | 'decline', $3 = chat id
WITH decided AS (
    UPDATE assistant.proposals
       SET status = CASE WHEN $2::text = 'approve' THEN 'approved' ELSE 'declined' END,
           decided_at = now()
     WHERE id = $1::bigint AND chat_id = $3::text
       AND status = 'pending' AND expires_at > now()
    RETURNING id, kind, payload, summary, status, true AS ok
), expired AS (
    UPDATE assistant.proposals
       SET status = 'expired', decided_at = now()
     WHERE id = $1::bigint AND chat_id = $3::text
       AND status = 'pending' AND expires_at <= now()
    RETURNING id, kind, payload, summary, status, false AS ok
)
SELECT * FROM decided
UNION ALL
SELECT * FROM expired
UNION ALL
SELECT id, kind, payload, summary, status, false AS ok
  FROM assistant.proposals
 WHERE id = $1::bigint AND chat_id = $3::text
   AND NOT EXISTS (SELECT 1 FROM decided)
   AND NOT EXISTS (SELECT 1 FROM expired);
