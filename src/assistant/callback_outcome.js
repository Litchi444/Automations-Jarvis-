// Code node "Decision outcome" (Run Once for All Items)
// Input: the row returned by the atomic "Claim decision" query, or an empty
// item if the proposal doesn't exist (node has alwaysOutputData on).
// Output `route`: 0 = create the event, 1 = just update the card.

const r = $('Route update').first().json;
const row = $input.first().json || {};
const base = row.summary || 'This suggestion';

let route = 1;
let toast;
let editText;

if (!row.id) {
  toast = 'Suggestion not found';
  editText = `${base}\n\n⚠️ This suggestion no longer exists.`;
} else if (row.ok && row.status === 'approved') {
  route = 0;
  toast = 'Adding…';
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
  json: { route, toast, editText, proposalId: r.proposalId, payload: row.payload || null, summary: base },
}];
