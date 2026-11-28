-- "Load style" (assistant) and "Get style" (morning briefing): the answer style chosen
-- with /style for this chat, or the default style 'jarvis' when none is chosen
-- (no row, or /style off). Keep the default name in sync with set_style.sql.
-- $1 chat id. Always returns exactly one row; style and body are NULL only when the
-- chosen style and the default are both missing from assistant.styles.
SELECT s.name AS style, s.body
  FROM (SELECT 1) AS one
  LEFT JOIN assistant.chat_settings c ON c.chat_id = $1::text
  LEFT JOIN assistant.styles s ON s.name = COALESCE(c.style, 'jarvis');
