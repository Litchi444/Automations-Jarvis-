-- $1 = proposal id
UPDATE assistant.proposals
   SET result = coalesce(result, '{}'::jsonb) || jsonb_build_object('undoneAt', now())
 WHERE id = $1::bigint AND status = 'undone'
RETURNING summary || E'\n\n↩️ Undone.' AS "editText",
          'Undone' AS toast;
