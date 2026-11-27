-- Store one university email from the IMAP trigger. Idempotent on Message-ID.
-- Also prunes copies older than 180 days so the mailbox copy stays bounded.
-- $1 message_id, $2 from, $3 to, $4 subject, $5 body, $6 received_at (ISO 8601)
WITH pruned AS (
    DELETE FROM assistant.uni_emails
     WHERE received_at < now() - interval '180 days'
)
INSERT INTO assistant.uni_emails (message_id, from_addr, to_addr, subject, body, received_at)
VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
ON CONFLICT (message_id) DO NOTHING
RETURNING id;
