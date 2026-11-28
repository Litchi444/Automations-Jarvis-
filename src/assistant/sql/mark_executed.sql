-- $1 = proposal id, $2 = result ({ id, title, link } from Google; empty after a delete)
UPDATE assistant.proposals
   SET status = 'executed', result = $2::jsonb
 WHERE id = $1::bigint AND status = 'approved'
RETURNING id, kind,
          summary || E'\n\n' || CASE kind
              WHEN 'calendar_event' THEN '✅ Added to your calendar.'
              WHEN 'event_move'     THEN '✅ Event moved.'
              WHEN 'event_delete'   THEN '🗑 Event deleted.'
              WHEN 'task_add'       THEN '✅ Added to your tasks.'
              WHEN 'task_done'      THEN '✅ Done: ' || coalesce(nullif($2::jsonb->>'title', ''), payload->>'title') || '.'
              WHEN 'task_delete'    THEN '🗑 Task deleted.'
          END AS "editText",
          CASE kind
              WHEN 'calendar_event' THEN 'Added to your calendar'
              WHEN 'event_move'     THEN 'Event moved'
              WHEN 'event_delete'   THEN 'Event deleted'
              WHEN 'task_add'       THEN 'Added to your tasks'
              WHEN 'task_done'      THEN 'Marked done'
              WHEN 'task_delete'    THEN 'Task deleted'
          END AS toast,
          instant AS undoable;
