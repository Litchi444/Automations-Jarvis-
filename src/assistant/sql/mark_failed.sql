-- $1 = proposal id, $2 = error message
UPDATE assistant.proposals
   SET status = 'failed', result = jsonb_build_object('error', $2::text)
 WHERE id = $1::bigint AND status = 'approved'
RETURNING id, kind,
          summary || E'\n\n⚠️ Could not ' || CASE kind
              WHEN 'event_move'   THEN 'move it'
              WHEN 'event_delete' THEN 'delete it'
              WHEN 'task_done'    THEN 'mark it done'
              WHEN 'task_delete'  THEN 'delete it'
              WHEN 'email_unsubscribe' THEN 'unsubscribe'
              ELSE 'add it'
          END || ': ' || left(coalesce($2::text, 'unknown error'), 200) AS "editText",
          'Failed' AS toast,
          false AS undoable;
