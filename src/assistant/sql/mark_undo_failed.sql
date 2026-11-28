-- The inverse failed: back to 'executed' so the row tells the truth. $1 = proposal id, $2 = error
UPDATE assistant.proposals
   SET status = 'executed'
 WHERE id = $1::bigint AND status = 'undone'
RETURNING summary || E'\n\n⚠️ Could not undo it: ' || left(coalesce($2::text, 'unknown error'), 200)
                  || E'\nFix it in Google Tasks.' AS "editText",
          'Undo failed' AS toast;
