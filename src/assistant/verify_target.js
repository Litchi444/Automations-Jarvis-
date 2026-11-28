// Code nodes "Check event" and "Check task" (Run Once for All Items)
// Runs after an approved move/delete/done tap, on the event or task fetched by its STORED id.
// The card showed a title and time; if the real item no longer matches them (wrong id from
// the agent, or the item changed since), this throws and the node's error output marks the
// proposal failed. So a tap can never move, complete or delete something other than what
// the card showed. Output: { kind, payload } for the writer.

const d = $('Decision outcome').first().json;
const p = d.payload || {};
const got = $input.first().json || {};

// Same normalisation as parse_agent_output.js, so titles compare equal.
const clean = (v, max) => String(v ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

if (d.kind === 'event_move' || d.kind === 'event_delete') {
  if (!got.id || got.status === 'cancelled') throw new Error('this event no longer exists');
  if (clean(got.summary, 120) !== p.title) throw new Error('the event title changed since the card was made');
  const want = d.kind === 'event_move' ? p.oldStart : p.start;
  const ok = got.start?.dateTime
    ? new Date(got.start.dateTime).getTime() === new Date(want).getTime()
    : got.start?.date === want;
  if (!ok) throw new Error('the event time changed since the card was made');
} else if (d.kind === 'task_done' || d.kind === 'task_delete') {
  if (!got.id || got.deleted) throw new Error('this task no longer exists');
  if (clean(got.title, 120) !== p.title) throw new Error('the task title changed since the card was made');
} else {
  throw new Error(`unexpected kind ${d.kind}`);
}

return [{ json: { kind: d.kind, payload: p } }];
