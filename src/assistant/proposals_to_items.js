// Code node "One item per proposal" (Run Once for All Items)
// Returning [] (no proposals) simply ends this branch.

const p = $('Parse + validate').first().json;
return (p.proposals || []).map(x => ({
  json: { chatId: p.chatId, kind: x.kind, payload: x.payload, summary: x.summary },
}));
