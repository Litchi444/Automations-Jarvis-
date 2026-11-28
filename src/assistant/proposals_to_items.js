// Code node "One item per proposal" (Run Once for All Items)
// Returning [] (no proposals) simply ends this branch.
// Output `mode`: MODE.card = save + approval card, MODE.instant = run now with an Undo button
// (must match MODE in src/build_workflows.py). Only "Parse + validate" sets `instant`,
// and only for task_add / task_done the user's own message asked for.

const MODE = { card: 0, instant: 1 };
const INSTANT_KINDS = ['task_add', 'task_done'];

const p = $('Parse + validate').first().json;
return (p.proposals || []).map(x => ({
  json: {
    chatId: p.chatId,
    kind: x.kind,
    payload: x.payload,
    summary: x.summary,
    mode: x.instant === true && INSTANT_KINDS.includes(x.kind) ? MODE.instant : MODE.card,
  },
}));
