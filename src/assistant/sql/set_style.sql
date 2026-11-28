-- "/style" command. Plain workflow node fed by the user's own message, never by the agent.
-- $1 chat id, $2 argument: '' lists the styles, 'off' resets to the default, a style name
-- selects it, anything else is reported as unknown. Always returns exactly one row: { reply }.
WITH arg AS (
    SELECT lower(btrim($2::text)) AS name
), target AS (
    -- The value to store: NULL for 'off', the style name if it exists. No row = nothing to store.
    SELECT CASE WHEN a.name = 'off' THEN NULL ELSE s.name END AS style
      FROM arg a
      LEFT JOIN assistant.styles s ON s.name = a.name
     WHERE a.name = 'off' OR s.name IS NOT NULL
), saved AS (
    INSERT INTO assistant.chat_settings (chat_id, style)
    SELECT $1::text, style FROM target
    ON CONFLICT (chat_id) DO UPDATE SET style = EXCLUDED.style, updated_at = now()
    RETURNING style
), cur AS (
    SELECT style FROM assistant.chat_settings WHERE chat_id = $1::text
)
SELECT CASE
         WHEN EXISTS (SELECT 1 FROM saved) THEN
           COALESCE('Style set: ' || (SELECT style FROM saved) || '. Send /style off to go back to the default.',
                    'Style reset to the default.')
         ELSE
           CASE WHEN (SELECT name FROM arg) <> ''
                THEN 'Unknown style "' || left((SELECT name FROM arg), 64) || E'".\n\n' ELSE '' END
           || 'Current style: ' || COALESCE((SELECT style FROM cur), 'default') || E'\n\n'
           -- 'jarvis' is the default style (see load_style.sql).
           || COALESCE((SELECT string_agg('• ' || name || CASE WHEN name = 'jarvis' THEN ' (default)' ELSE '' END
                                          || ': ' || description, E'\n' ORDER BY name)
                          FROM assistant.styles), 'No styles installed.')
           || E'\n\nSend /style <name> to choose one, /style off for the default.'
       END AS reply;
