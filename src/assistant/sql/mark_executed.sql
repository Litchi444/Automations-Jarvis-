UPDATE assistant.proposals
   SET status = 'executed', result = $2::jsonb
 WHERE id = $1::bigint AND status = 'approved'
RETURNING summary || E'\n\n✅ Added to your calendar.' AS "editText",
          'Added to your calendar' AS toast;
