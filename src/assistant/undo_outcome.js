// Code node "Undo outcome" (Run Once for All Items)
// Input: the row returned by the atomic "Claim undo" query, or an empty item if the
// proposal doesn't exist (node has alwaysOutputData on).
// Output `route`: UNDO.run = reverse it ("Undo which?" picks by kind), UNDO.cardOnly = just
// update the message (must match UNDO in src/build_workflows.py).

const UNDO = { run: 0, cardOnly: 1 };

const r = $('Route update').first().json;
const row = $input.first().json || {};
const base = row.summary || 'This action';
const taskId = String(row.result?.id || '');

let route = UNDO.cardOnly;
let toast;
let editText;

if (!row.id) {
  toast = 'Not found';
  editText = `${base}\n\n⚠️ This action no longer exists.`;
} else if (row.ok && /^[A-Za-z0-9_-]{1,128}$/.test(taskId)) {
  route = UNDO.run;
  toast = 'Undoing…';
  editText = null; // set by "Mark undone" / "Mark undo failed"
} else if (row.ok) {
  // Claimed, but there is no task id to reverse: report it (the row stays 'undone').
  toast = 'Cannot undo';
  editText = `${base}\n\n⚠️ Could not undo it: no task id was saved. Fix it in Google Tasks.`;
} else if (row.status === 'undone') {
  toast = 'Already undone';
  editText = `${base}\n\nℹ️ Already undone.`;
} else if (row.status === 'executed') {
  toast = 'Too late to undo';
  editText = `${base}\n\n⌛ Undo is only possible for 24 hours. Change it in Google Tasks.`;
} else {
  toast = 'Nothing to undo';
  editText = `${base}\n\nℹ️ Nothing to undo (${row.status}).`;
}

return [{
  json: { route, toast, editText, proposalId: r.proposalId, kind: row.kind || null, result: row.result || null },
}];
