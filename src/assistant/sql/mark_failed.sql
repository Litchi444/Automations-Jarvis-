UPDATE assistant.proposals
   SET status = 'failed', result = jsonb_build_object('error', $2::text)
 WHERE id = $1::bigint AND status = 'approved'
RETURNING summary || E'\n\n⚠️ Could not add it: ' || left(coalesce($2::text, 'unknown error'), 200) AS "editText",
          'Failed to add' AS toast;
