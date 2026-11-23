const fs = require('fs');
const S = require('path').join(__dirname, '..', 'src') + '/';
let pass = 0;
const ok = (c, m) => { if (!c) { console.log('  ✗ FAIL:', m); process.exitCode = 1; } else { pass++; console.log('  ✓', m); } };
function run(file, nodes = {}, input = {}, env = { TELEGRAM_CHAT_ID: '111', GENERIC_TIMEZONE: 'Europe/Paris' }) {
  const $ = n => { if (!nodes[n]) throw new Error('missing node ref ' + n); return { first: () => ({ json: nodes[n][0] }), all: () => nodes[n].map(j => ({ json: j })) }; };
  const $input = { first: () => ({ json: input }) };
  return new Function('$', '$input', '$env', 'Buffer', fs.readFileSync(S + file, 'utf8'))($, $input, env, Buffer);
}
const R = 'assistant/route_update.js';
const T = u => run(R, { 'Telegram Trigger': [u] });
const priv = (extra) => ({ message: { chat: { id: 111, type: 'private' }, from: { id: 111 }, ...extra } });

console.log('route_update');
let o = T(priv({ voice: { file_id: 'F1', duration: 7, mime_type: 'audio/ogg' } }));
ok(o[0].json.route === 0 && o[0].json.fileId === 'F1', 'voice → route 0 with fileId');
o = T(priv({ text: '  what is on today? ' }));
ok(o[0].json.route === 1 && o[0].json.text === 'what is on today?', 'text → route 1, trimmed');
o = T(priv({ text: '/start' }));
ok(/introduce/.test(o[0].json.text), '/start → intro prompt');
ok(T({ message: { chat: { id: 999, type: 'private' }, from: { id: 999 }, text: 'hi' } }).length === 0, 'stranger → dropped');
ok(T({ message: { chat: { id: 111, type: 'group' }, from: { id: 111 }, text: 'hi' } }).length === 0, 'group chat → dropped');
ok(T(priv({ sticker: {} })).length === 0, 'sticker → ignored');
o = T(priv({ voice: { file_id: 'F', duration: 900 } }));
ok(o[0].json.route === 1 && /longer than 5 minutes/.test(o[0].json.text), 'voice > 5 min → not downloaded, polite note');
const cb = (data, chat = 111, from = 111) => ({ callback_query: { id: 'CB1', data, from: { id: from }, message: { message_id: 55, chat: { id: chat } } } });
o = T(cb('ap:42'));
ok(o[0].json.route === 2 && o[0].json.action === 'approve' && o[0].json.proposalId === '42' && o[0].json.messageId === 55, 'approve tap → route 2');
ok(T(cb('no:42'))[0].json.action === 'decline', 'decline tap');
ok(T(cb('ap:42; DROP TABLE x')).length === 0, 'malformed callback data → dropped');
ok(T(cb('ap:42', 111, 999)).length === 0, 'tap from someone else → dropped');
let threw = false; try { run(R, { 'Telegram Trigger': [priv({ text: 'x' })] }, {}, {}); } catch { threw = true; }
ok(threw, 'missing TELEGRAM_CHAT_ID → hard error, never open to everyone');

console.log('prepare_agent_input');
o = run('assistant/prepare_agent_input.js', { 'Route update': [{ kind: 'voice', chatId: '111' }] },
  { candidates: [{ content: { parts: [{ text: 'Qu\'est-ce que j\'ai demain ?' }] } }] });
ok(o[0].json.userText.startsWith("Qu'est-ce") && o[0].json.inputMode === 'voice' && o[0].json.sessionKey === 'telegram-111', 'voice transcript → userText, session key');
o = run('assistant/prepare_agent_input.js', { 'Route update': [{ kind: 'voice', chatId: '111' }] }, { candidates: [] });
ok(/inaudible/.test(o[0].json.userText), 'empty transcript → inaudible marker');
o = run('assistant/prepare_agent_input.js', { 'Route update': [{ kind: 'text', chatId: '111', text: 'hi' }] }, {});
ok(o[0].json.userText === 'hi' && o[0].json.inputMode === 'text', 'text passes through');

console.log('parse_agent_output');
const day = 86400e3, iso = ms => new Date(ms).toISOString().replace('Z', '+00:00');
const t0 = Date.now() + 2 * day, P = 'assistant/parse_agent_output.js';
const ctxV = { 'Prepare agent input': [{ chatId: '111', inputMode: 'voice' }] };
const ev = (o = {}) => ({ type: 'calendar_event', title: 'Coffee with Sara', start: iso(t0), end: iso(t0 + 3600e3), location: 'Café', reason: 'From Sara\'s email', ...o });
const parse = (output, ctx = ctxV) => run(P, ctx, { output })[0].json;
o = parse(JSON.stringify({ reply: 'You have **two** meetings https://x.y tomorrow.', proposals: [ev()] }));
ok(o.reply === 'You have two meetings tomorrow.' && o.text === o.reply, 'reply cleaned of markdown + URLs, mirrored to text');
ok(o.proposals.length === 1 && o.proposals[0].payload.title === 'Coffee with Sara' && /📅 Coffee with Sara\n🕒 .+\n📍 Café\n💡/.test(o.proposals[0].summary), 'valid proposal → payload + card summary');
ok(o.replyRoute === 0, 'voice in → voice reply route');
ok(parse('```json\n' + JSON.stringify({ reply: 'ok', proposals: [] }) + '\n```').reply === 'ok', 'code-fenced JSON tolerated');
o = parse('Sure! Tomorrow you are free.');
ok(o.reply === 'Sure! Tomorrow you are free.' && o.proposals.length === 0, 'non-JSON → answered, no proposals');
o = parse(JSON.stringify({ reply: 'x', proposals: [
  ev({ start: '2026-12-01T10:00:00', end: '2026-12-01T11:00:00' }),
  ev({ start: iso(Date.now() - 3 * day), end: iso(Date.now() - 3 * day + 3600e3) }),
  ev({ end: iso(t0 - 60e3) }),
  ev({ end: iso(t0 + 20 * 3600e3) }),
  ev({ type: 'send_email' }),
  ev({ title: '   ' }),
] }));
ok(o.proposals.length === 0 && o.rejectedProposals.length === 6, `6 bad proposals rejected (${o.rejectedProposals.join(' | ')})`);
ok(/dropped 6 suggestions/.test(o.reply), 'user told that suggestions were dropped');
o = parse(JSON.stringify({ reply: 'many', proposals: [ev(), ev(), ev(), ev(), ev()] }));
ok(o.proposals.length === 3, 'max 3 proposals per turn');
o = parse(JSON.stringify({ reply: '', proposals: [ev({ title: 'A\u0000B' + 'x'.repeat(300) })] }), { 'Prepare agent input': [{ chatId: '111', inputMode: 'text' }] });
ok(o.proposals[0].payload.title.length === 120 && !o.proposals[0].payload.title.includes('\u0000') && o.replyRoute === 1 && o.reply, 'title sanitized + capped, text route, empty reply filled');

console.log('proposals_to_items');
o = run('assistant/proposals_to_items.js', { 'Parse + validate': [{ chatId: '111', proposals: [{ kind: 'calendar_event', payload: { a: 1 }, summary: 's' }, { kind: 'calendar_event', payload: {}, summary: 't' }] }] });
ok(o.length === 2 && o[0].json.chatId === '111', 'one item per proposal');
ok(run('assistant/proposals_to_items.js', { 'Parse + validate': [{ chatId: '1', proposals: [] }] }).length === 0, 'no proposals → branch ends');

console.log('callback_outcome');
const C = (row) => run('assistant/callback_outcome.js', { 'Route update': [{ proposalId: '7' }] }, row)[0].json;
ok(C({ id: 7, ok: true, status: 'approved', summary: 'S', payload: { title: 'x' } }).route === 0, 'approved → create route');
ok(/❌ Declined/.test(C({ id: 7, ok: true, status: 'declined', summary: 'S' }).editText), 'declined → card updated');
ok(/⌛ Expired/.test(C({ id: 7, ok: false, status: 'expired', summary: 'S' }).editText), 'expired → card updated');
ok(/Already being processed/.test(C({ id: 7, ok: false, status: 'pending', summary: 'S' }).editText), 'race loser → being processed');
ok(/Already executed/.test(C({ id: 7, ok: false, status: 'executed', summary: 'S' }).editText) && C({ id: 7, ok: false, status: 'executed' }).route === 1, 'double tap → no second create');
ok(/no longer exists/.test(C({}).editText), 'unknown proposal → handled');
console.log(`\n${pass} passed`);
