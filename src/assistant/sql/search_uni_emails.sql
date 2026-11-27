-- Read-only agent tool "Uni mail: search".
-- $1 words to find in sender, subject or body ('' = all), $2 days to look back (1-365, default 14).
-- strpos instead of LIKE so % and _ typed by the model are plain characters.
SELECT id, received_at, from_addr, subject, left(body, 300) AS preview
  FROM assistant.uni_emails
 WHERE received_at >= now() - make_interval(
           days => LEAST(GREATEST(COALESCE(NULLIF(btrim($2::text), '')::numeric::int, 14), 1), 365))
   AND (btrim($1::text) = ''
        OR strpos(lower(from_addr || ' ' || subject || ' ' || body), lower(btrim($1::text))) > 0)
 ORDER BY received_at DESC
 LIMIT 10;
