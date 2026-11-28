// Code node "Decision outcome" (Run Once for All Items)
// Input: the row returned by the atomic "Claim decision" query, or an empty
// item if the proposal doesn't exist (node has alwaysOutputData on).
// Output `route`: OUTCOME.execute = run the approved action, OUTCOME.cardOnly = just update
// the card (must match OUTCOME in src/build_workflows.py). "Which action?" then picks the
// writer from `kind`.

const OUTCOME = { execute: 0, cardOnly: 1 };
const WORKING = {
  calendar_event: 'Adding…', event_move: 'Moving…', event_delete: 'Deleting…',
  task_add: 'Adding…', task_done: 'Marking done…', task_delete: 'Deleting…',
};

const r = $('Route update').first().json;
const row = $input.first().json || {};
const base = row.summary || 'This suggestion';

let route = OUTCOME.cardOnly;
let toast;
let editText;

if (!row.id) {
  toast = 'Suggestion not found';
  editText = `${base}\n\n⚠️ This suggestion no longer exists.`;
} else if (row.ok && row.status === 'approved') {
  route = OUTCOME.execute;
  toast = WORKING[row.kind] || 'Working…';
  editText = null; // set by "Mark executed" / "Mark failed"
} else if (row.ok && row.status === 'declined') {
  toast = 'Declined';
  editText = `${base}\n\n❌ Declined.`;
} else if (row.status === 'expired') {
  toast = 'Expired';
  editText = `${base}\n\n⌛ Expired. Ask me again if you still want it.`;
} else if (row.status === 'pending') {
  toast = 'Already being processed';
  editText = `${base}\n\n⏳ Already being processed.`;
} else {
  toast = `Already ${row.status}`;
  editText = `${base}\n\nℹ️ Already ${row.status}.`;
}

return [{
  json: {
    route, toast, editText, proposalId: r.proposalId,
    kind: row.kind || null, payload: row.payload || null, summary: base,
  },
}];
