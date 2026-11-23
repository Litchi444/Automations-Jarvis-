INSERT INTO assistant.proposals (chat_id, kind, payload, summary, expires_at)
VALUES ($1, $2, $3::jsonb, $4, now() + make_interval(hours => $5::int))
RETURNING id, chat_id, summary, expires_at;
