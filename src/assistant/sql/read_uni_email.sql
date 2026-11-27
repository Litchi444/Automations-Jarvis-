-- Read-only agent tool "Uni mail: read email". $1 id from "Uni mail: search".
SELECT id, received_at, from_addr, to_addr, subject, body
  FROM assistant.uni_emails
 WHERE id = $1::bigint;
