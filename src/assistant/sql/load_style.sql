-- "Load style" (assistant) and "Get style" (morning briefing): the answer style chosen
-- with /style for this chat. $1 chat id.
-- Always returns exactly one row; style and body are NULL when none is chosen.
SELECT s.name AS style, s.body
  FROM (SELECT 1) AS one
  LEFT JOIN assistant.chat_settings c ON c.chat_id = $1::text
  LEFT JOIN assistant.styles s ON s.name = c.style;
