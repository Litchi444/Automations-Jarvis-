-- Morning briefing: university emails received in the last 24 hours.
SELECT id, received_at, from_addr, subject, left(body, 300) AS preview
  FROM assistant.uni_emails
 WHERE received_at >= now() - interval '1 day'
 ORDER BY received_at DESC
 LIMIT 8;
