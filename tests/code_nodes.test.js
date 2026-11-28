const fs = require('fs');
const S = require('path').join(__dirname, '..', 'src') + '/';
let pass = 0;
const ok = (c, m) => { if (!c) { console.log('  ✗ FAIL:', m); process.exitCode = 1; } else { pass++; console.log('  ✓', m); } };
function run(file, nodes = {}, input = {}, env = { TELEGRAM_CHAT_ID: '111', GENERIC_TIMEZONE: 'Europe/Paris' }) {
  const $ = n => { if (!nodes[n]) throw new Error('missing node ref ' + n); return { first: () => ({ json: nodes[n][0] }), all: () => nodes[n].map(j => ({ json: j })) }; };
  const $input = { first: () => ({ json: input }), all: () => [{ json: input }] };
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
o = T(cb('un:42'));
ok(o[0].json.route === 4 && o[0].json.action === 'undo' && o[0].json.proposalId === '42', 'undo tap → route 4');
ok(T(cb('un:42', 111, 999)).length === 0 && T(cb('rm:42')).length === 0, 'undo from someone else / unknown action → dropped');
ok(T(cb('ap:42; DROP TABLE x')).length === 0, 'malformed callback data → dropped');
ok(T(cb('ap:42', 111, 999)).length === 0, 'tap from someone else → dropped');
o = T(priv({ text: '/style' }));
ok(o[0].json.route === 3 && o[0].json.kind === 'style' && o[0].json.styleArg === '', '/style → route 3, list (empty arg)');
o = T(priv({ text: '  /style   Butler  ' }));
ok(o[0].json.route === 3 && o[0].json.styleArg === 'Butler', '/style <name> → route 3 with trimmed arg');
ok(T(priv({ text: '/style@JarvisBot off' }))[0].json.styleArg === 'off', '/style@bot off → arg off');
ok(T(priv({ text: '/style ' + 'a'.repeat(200) }))[0].json.styleArg.length === 64, 'style arg capped at 64 chars');
ok(T(priv({ text: '/styles please' }))[0].json.route === 1 && T(priv({ text: 'change your /style' }))[0].json.route === 1, 'not the exact command → normal text to the agent');
ok(T({ message: { chat: { id: 999, type: 'private' }, from: { id: 999 }, text: '/style butler' } }).length === 0, '/style from a stranger → dropped');
let threw = false; try { run(R, { 'Telegram Trigger': [priv({ text: 'x' })] }, {}, {}); } catch { threw = true; }
ok(threw, 'missing TELEGRAM_CHAT_ID → hard error, never open to everyone');

console.log('prepare_agent_input');
const PA = 'assistant/prepare_agent_input.js';
const noStyle = { style: null, body: null };
o = run(PA, { 'Route update': [{ kind: 'voice', chatId: '111' }], 'Gemini: transcribe': [{ candidates: [{ content: { parts: [{ text: 'Qu\'est-ce que j\'ai demain ?' }] } }] }] }, noStyle);
ok(o[0].json.userText.startsWith("Qu'est-ce") && o[0].json.inputMode === 'voice' && o[0].json.sessionKey === 'telegram-111', 'voice transcript → userText, session key');
ok(o[0].json.style === '' && o[0].json.styleBody === '', 'no style chosen → empty style');
o = run(PA, { 'Route update': [{ kind: 'voice', chatId: '111' }], 'Gemini: transcribe': [{ candidates: [] }] }, noStyle);
ok(/inaudible/.test(o[0].json.userText) && /ask them, in French, to repeat/.test(o[0].json.userText), 'empty transcript → ask to repeat');
o = run(PA, { 'Route update': [{ kind: 'voice', chatId: '111' }], 'Gemini: transcribe': [{ candidates: [{ content: { parts: [{ text: ' [UNCLEAR]\n' }] } }] }] }, noStyle);
ok(/could not be understood/.test(o[0].json.userText) && /propose nothing/.test(o[0].json.userText), 'UNCLEAR (unsure / not French or English) → ask to repeat, no guessing');
o = run(PA, { 'Route update': [{ kind: 'voice', chatId: '111' }], 'Gemini: transcribe': [{ candidates: [{ content: { parts: [{ text: 'Unclear what to do today' }] } }] }] }, noStyle);
ok(o[0].json.userText === 'Unclear what to do today', 'the word "unclear" inside a real sentence is kept');
o = run(PA, { 'Route update': [{ kind: 'text', chatId: '111', text: 'hi' }] }, noStyle);
ok(o[0].json.userText === 'hi' && o[0].json.inputMode === 'text', 'text passes through (transcribe node not touched)');
o = run(PA, { 'Route update': [{ kind: 'text', chatId: '111', text: 'hi' }] }, { style: 'butler', body: '  Be formal.  ' + 'x'.repeat(3000) });
ok(o[0].json.style === 'butler' && o[0].json.styleBody.startsWith('Be formal.') && o[0].json.styleBody.length === 2000, 'chosen style → name + trimmed body, capped at 2000');
o = run(PA, { 'Route update': [{ kind: 'text', chatId: '111', text: 'hi' }] }, { error: 'relation "assistant.styles" does not exist' });
ok(o[0].json.style === '' && o[0].json.styleBody === '' && o[0].json.userText === 'hi', 'failed style lookup → default style, still answers');

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
o = parse(JSON.stringify({ reply: 'hi', proposals: [] }), { 'Prepare agent input': [{ chatId: '111', inputMode: 'text' }] });
ok(o.replyRoute === 0, 'text in, no format → voice reply by default');
o = parse(JSON.stringify({ reply: 'hi', format: 'TEXT', proposals: [] }));
ok(o.replyRoute === 1, 'format "text" → text reply route');
ok(parse('plain non-JSON answer').replyRoute === 0, 'non-JSON → voice reply');
o = parse(JSON.stringify({ reply: 'Objet : TP 3\r\n\r\n\r\n\r\nBonjour Madame X,  \n  Merci.\u0000' + 'y'.repeat(5000), format: 'text', proposals: [] }));
ok(o.reply.startsWith('Objet : TP 3\n\nBonjour Madame X,\nMerci. y') && o.reply.length === 3500, 'text reply (draft) keeps line breaks, capped at 3500');
o = parse(JSON.stringify({ reply: 'Line one\nLine two ' + 'z'.repeat(2000), proposals: [] }));
ok(o.reply.startsWith('Line one Line two') && o.reply.length === 1500, 'voice reply stays one paragraph, capped at 1500');
ok(parse('```json\n' + JSON.stringify({ reply: 'ok', proposals: [] }) + '\n```').reply === 'ok', 'code-fenced JSON tolerated');
o = parse('{"reply": "Objet : RDV\n\nBonjour,\n\tA demain.\n\nJarvis", "format": "text", "proposals": []}');
ok(o.replyRoute === 1 && o.reply.startsWith('Objet : RDV\n\nBonjour,') && !o.reply.includes('"format"'), 'raw line breaks inside JSON strings tolerated');
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
o = parse(JSON.stringify({ reply: '', format: 'text', proposals: [ev({ title: 'A\u0000B' + 'x'.repeat(300) })] }), { 'Prepare agent input': [{ chatId: '111', inputMode: 'text' }] });
ok(o.proposals[0].payload.title.length === 120 && !o.proposals[0].payload.title.includes('\u0000') && o.replyRoute === 1 && o.reply, 'title sanitized + capped, text route, empty reply filled');

console.log('parse_agent_output: tasks, moves, deletes, instant gate');
const ctxAsk = text => ({ 'Prepare agent input': [{ chatId: '111', inputMode: 'voice', userText: text }] });
const one = (prop, text = 'ajoute acheter du lait à ma TDL') => parse(JSON.stringify({ reply: 'ok', proposals: [prop] }), ctxAsk(text));
const todayParis = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
o = one({ type: 'task_add', title: 'Acheter du lait', due: todayParis, reason: 'asked' });
ok(o.proposals.length === 1 && o.proposals[0].instant === true && o.proposals[0].payload.due === todayParis
  && /📝 Add task: Acheter du lait\n📆 Due today/.test(o.proposals[0].summary), 'task_add the user asked for (FR, TDL) → instant, due today');
ok(one({ type: 'task_add', title: 'Buy milk' }, 'add buy milk to my to-do list').proposals[0].instant === true, 'EN "to-do list" → instant');
ok(one({ type: 'task_add', title: 'Réviser' }, 'mets réviser dans mes tâches').proposals[0].instant === true, '"tâches" → instant');
o = one({ type: 'task_add', title: 'Pay invoice', reason: 'From the email' }, 'check my emails');
ok(o.proposals[0].instant === false, 'task_add NOT asked for (e.g. from an email) → card, never instant');
ok(one({ type: 'task_add', title: 'x' }, 'what tasking do I have').proposals[0].instant === false, 'word inside another word does not open the gate');
o = one({ type: 'task_done', taskId: 'abc_1-Z', title: 'Essay' }, "j'ai fini l'essai");
ok(o.proposals[0].instant === true && o.proposals[0].payload.taskId === 'abc_1-Z' && /☑️ Mark done: Essay/.test(o.proposals[0].summary), 'task_done with a "done" word → instant');
o = one({ type: 'task_delete', taskId: 'abc', title: 'Essay' }, 'delete the essay task');
ok(o.proposals[0].instant === false && /🗑 Delete task: Essay/.test(o.proposals[0].summary), 'task_delete → always a card');
o = one({ type: 'event_delete', eventId: 'ev123', title: 'Dentist', start: iso(t0) }, 'delete my dentist from the to-do list');
ok(o.proposals[0].instant === false && o.proposals[0].payload.eventId === 'ev123' && /🗑 Delete event: Dentist/.test(o.proposals[0].summary), 'event_delete → always a card');
o = one({ type: 'event_delete', eventId: 'ev9', title: 'Holiday', start: '2026-12-24' });
ok(o.proposals[0].payload.start === '2026-12-24' && /all day/.test(o.proposals[0].summary), 'all-day event delete keeps the date');
o = one({ type: 'event_move', eventId: 'ev1', title: 'Dentist', oldStart: iso(t0), start: iso(t0 + day), end: iso(t0 + day + 3600e3) });
ok(o.proposals[0].kind === 'event_move' && !o.proposals[0].instant && /🔀 Move event: Dentist\n🕒 From .+\n➡️ To /.test(o.proposals[0].summary), 'event_move → card with from / to');
o = parse(JSON.stringify({ reply: 'x', proposals: [
  { type: 'task_add', title: 'x', due: 'tomorrow' },
  { type: 'task_add', title: 'x', due: '2020-01-01' },
  { type: 'task_done', taskId: '../etc', title: 'x' },
  { type: 'task_delete', title: 'x' },
  { type: 'event_delete', eventId: 'a b', title: 'x', start: iso(t0) },
  { type: 'event_delete', eventId: 'ok', title: 'x', start: 'soon' },
  { type: 'event_move', eventId: 'ok', title: 'x', oldStart: '2026-12-01', start: iso(t0), end: iso(t0 + 3600e3) },
  { type: 'task_add', title: '  ' },
] }), ctxAsk('add to my todo'));
ok(o.proposals.length === 0 && o.rejectedProposals.length === 8, `8 bad task/event proposals rejected (${o.rejectedProposals.join(' | ')})`);
o = one({ type: 'email_unsubscribe', messageId: '18c9f0a1b2c3d4e5', from: 'Zalando <News@Zalando.FR>', title: 'Zalando', reason: 'promo' },
  'unsubscribe me from Zalando, add it to my to-do list');
ok(o.proposals.length === 1 && o.proposals[0].instant === false && o.proposals[0].payload.from === 'news@zalando.fr'
  && o.proposals[0].payload.messageId === '18c9f0a1b2c3d4e5' && /📭 Unsubscribe: Zalando\n✉️ news@zalando.fr/.test(o.proposals[0].summary),
'email_unsubscribe → always a card, sender address normalised');
o = parse(JSON.stringify({ reply: 'x', proposals: [
  { type: 'email_unsubscribe', messageId: '../x', from: 'a@b.fr', title: 'x' },
  { type: 'email_unsubscribe', messageId: '18c9f0a1b2c3', from: 'not an address', title: 'x' },
  { type: 'email_unsubscribe', messageId: '18c9f0a1b2c3', from: 'a@localhost', title: 'x' },
  { type: 'email_unsubscribe', messageId: '18c9f0a1b2c3', from: 'a@b.fr', title: ' ' },
] }), ctxAsk('unsubscribe me'));
ok(o.proposals.length === 0 && o.rejectedProposals.length === 4, `4 bad unsubscribe proposals rejected (${o.rejectedProposals.join(' | ')})`);

console.log('proposals_to_items');
o = run('assistant/proposals_to_items.js', { 'Parse + validate': [{ chatId: '111', proposals: [{ kind: 'calendar_event', payload: { a: 1 }, summary: 's' }, { kind: 'calendar_event', payload: {}, summary: 't' }] }] });
ok(o.length === 2 && o[0].json.chatId === '111' && o[0].json.mode === 0, 'one item per proposal, card by default');
o = run('assistant/proposals_to_items.js', { 'Parse + validate': [{ chatId: '1', proposals: [
  { kind: 'task_add', instant: true }, { kind: 'task_done', instant: true }, { kind: 'task_delete', instant: true }, { kind: 'calendar_event', instant: true }] }] });
ok(o.map(x => x.json.mode).join() === '1,1,0,0', 'instant only for task_add / task_done, even if flagged');
ok(run('assistant/proposals_to_items.js', { 'Parse + validate': [{ chatId: '1', proposals: [] }] }).length === 0, 'no proposals → branch ends');

console.log('callback_outcome');
const C = (row) => run('assistant/callback_outcome.js', { 'Route update': [{ proposalId: '7' }] }, row)[0].json;
o = C({ id: 7, ok: true, status: 'approved', kind: 'task_delete', summary: 'S', payload: { taskId: 'x' } });
ok(o.route === 0 && o.kind === 'task_delete' && o.payload.taskId === 'x' && o.toast === 'Deleting…', 'approved → execute route, kind + stored payload passed on');
ok(/❌ Declined/.test(C({ id: 7, ok: true, status: 'declined', summary: 'S' }).editText), 'declined → card updated');
ok(/Already declined/.test(C({ id: 7, ok: false, status: 'declined', summary: 'S' }).editText), 'tap on already-declined card → "already", not a fresh decline');
ok(/⌛ Expired/.test(C({ id: 7, ok: false, status: 'expired', summary: 'S' }).editText), 'expired → card updated');
ok(/Already being processed/.test(C({ id: 7, ok: false, status: 'pending', summary: 'S' }).editText), 'race loser → being processed');
ok(/Already executed/.test(C({ id: 7, ok: false, status: 'executed', summary: 'S' }).editText) && C({ id: 7, ok: false, status: 'executed' }).route === 1, 'double tap → no second create');
ok(/no longer exists/.test(C({}).editText), 'unknown proposal → handled');
console.log('verify_target');
const V = (kind, payload, got) => run('assistant/verify_target.js', { 'Decision outcome': [{ kind, payload }] }, got);
const throws = f => { try { f(); return false; } catch { return true; } };
const evP = { eventId: 'e1', title: 'Dentist', start: '2026-12-01T13:00:00.000Z' };
ok(V('event_delete', evP, { id: 'e1', summary: ' Dentist ', start: { dateTime: '2026-12-01T14:00:00+01:00' } })[0].json.payload.eventId === 'e1', 'event still matches the card → passes stored payload on');
ok(throws(() => V('event_delete', evP, { id: 'e1', summary: 'Other', start: { dateTime: '2026-12-01T14:00:00+01:00' } })), 'other title → refused');
ok(throws(() => V('event_delete', evP, { id: 'e1', summary: 'Dentist', start: { dateTime: '2026-12-01T15:00:00+01:00' } })), 'other time → refused');
ok(throws(() => V('event_delete', evP, { id: 'e1', summary: 'Dentist', status: 'cancelled', start: { dateTime: '2026-12-01T14:00:00+01:00' } })), 'cancelled → refused');
ok(V('event_delete', { eventId: 'e2', title: 'Holiday', start: '2026-12-24' }, { id: 'e2', summary: 'Holiday', start: { date: '2026-12-24' } }).length === 1, 'all-day event matched by date');
ok(V('event_move', { eventId: 'e1', title: 'Dentist', oldStart: evP.start }, { id: 'e1', summary: 'Dentist', start: { dateTime: evP.start } }).length === 1, 'move checks the OLD start');
ok(V('task_delete', { taskId: 't1', title: 'Essay' }, { id: 't1', title: 'Essay' }).length === 1, 'task still matches → ok');
ok(throws(() => V('task_done', { taskId: 't1', title: 'Essay' }, { id: 't1', title: 'Shopping' })), 'task title differs → refused');
ok(throws(() => V('task_delete', { taskId: 't1', title: 'Essay' }, {})) && throws(() => V('calendar_event', {}, { id: 'x' })), 'missing item / unexpected kind → refused');

console.log('unsubscribe_target');
const uP = { messageId: 'm1', from: 'news@shop.fr', title: 'Shop' };
const mail = (h, extra = {}) => ({ id: 'm1', from: { value: [{ address: 'News@Shop.fr', name: 'Shop' }] }, headers: h, ...extra });
const oneClick = list => ({ 'list-unsubscribe': `List-Unsubscribe: ${list}`, 'list-unsubscribe-post': 'List-Unsubscribe-Post: List-Unsubscribe=One-Click' });
const US = (got, kind = 'email_unsubscribe', payload = uP) => run('assistant/unsubscribe_target.js', { 'Decision outcome': [{ kind, payload }] }, got);
const uErr = got => { try { US(got); return ''; } catch (e) { return e.message; } };
o = US(mail(oneClick('<mailto:u@shop.fr?subject=stop>, <https://mail.shop.fr/u?t=abc>')))[0].json;
ok(o.url === 'https://mail.shop.fr/u?t=abc' && o.host === 'mail.shop.fr' && o.payload.messageId === 'm1', 'one-click header → https link from the header, mailto skipped');
ok(US(mail({ 'List-Unsubscribe': '<https://x.shop.fr/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }))[0].json.url === 'https://x.shop.fr/u', 'bare header values, any key case → ok');
ok(/no one-click/.test(uErr(mail({ 'list-unsubscribe': 'List-Unsubscribe: <https://mail.shop.fr/u>' }))), 'no List-Unsubscribe-Post → refused');
ok(/no one-click/.test(uErr(mail(oneClick('<mailto:u@shop.fr>')))), 'mailto only → refused (never sends an email)');
ok(/no one-click/.test(uErr(mail(oneClick('<http://mail.shop.fr/u>')))), 'plain http → refused');
for (const bad of ['https://127.0.0.1/u', 'https://0x7f.1/u', 'https://2130706433/u', 'https://[::1]/u', 'https://postgres/u',
  'https://n8n:5678/u', 'https://shop.fr:8443/u', 'https://user:pw@shop.fr/u', 'https://foo.localhost/u', 'https://box.internal/u', 'https://10.0.0.1/u',
  'https://0x7f.0x1/u', 'https://%31.shop.fr/u', 'https://evil.fr\\@postgres/u', 'https://shop.fr./u']) {
  ok(/unsafe/.test(uErr(mail(oneClick(`<${bad}>`)))), `unsafe link refused: ${bad}`);
}
ok(/sender changed/.test(uErr(mail(oneClick('<https://mail.shop.fr/u>'), { from: { value: [{ address: 'evil@other.fr' }] } }))), 'other sender → refused');
ok(/no longer exists/.test(uErr({})) && /no longer exists/.test(uErr(mail(oneClick('<https://a.shop.fr/u>'), { id: 'm2' }))), 'missing / other message → refused');
ok(throws(() => US(mail(oneClick('<https://a.shop.fr/u>')), 'task_delete')), 'unexpected kind → refused');

console.log('undo_outcome');
const U = row => run('assistant/undo_outcome.js', { 'Route update': [{ proposalId: '9' }] }, row)[0].json;
o = U({ id: 9, ok: true, status: 'undone', kind: 'task_add', summary: 'S', result: { id: 'task-1' } });
ok(o.route === 0 && o.kind === 'task_add' && o.result.id === 'task-1', 'claimed → run the inverse on the stored result');
ok(U({ id: 9, ok: true, status: 'undone', kind: 'task_add', summary: 'S', result: {} }).route === 1, 'claimed but no task id → card only, never a blind call');
ok(/Already undone/.test(U({ id: 9, ok: false, status: 'undone', summary: 'S' }).editText), 'double tap → already undone');
ok(/24 hours/.test(U({ id: 9, ok: false, status: 'executed', summary: 'S' }).editText), 'too old → too late');
ok(/no longer exists/.test(U({}).editText) && U({}).route === 1, 'unknown → handled');

console.log('school_day');
const ymd = todayParis.replace(/-/g, '');
const tomorrowYmd = new Date(Date.now() + day).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }).replace(/-/g, '');
const ev2 = (start, end, summary, loc, extra = '') => `BEGIN:VEVENT\r\nDTSTART;TZID=Europe/Paris:${ymd}T${start}00\r\nDTEND;TZID=Europe/Paris:${ymd}T${end}00\r\nSUMMARY:${summary}\r\nLOCATION:${loc}\r\n${extra}END:VEVENT\r\n`;
const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'
  + ev2('1015', '1200', 'Physique\\, TD', 'A1\r\n 01')                  // folded LOCATION, escaped comma
  + ev2('0800', '1000', 'Maths', 'B204')
  + ev2('1330', '1500', 'TP', 'Lab 3')
  + ev2('1500', '1700', 'Anglais', 'C12')
  + ev2('0900', '1000', 'Annulé', 'X', 'STATUS:CANCELLED\r\n')
  + `BEGIN:VEVENT\r\nDTSTART:${tomorrowYmd}T080000Z\r\nDTEND:${tomorrowYmd}T090000Z\r\nSUMMARY:Tomorrow\r\nEND:VEVENT\r\n`
  + 'END:VCALENDAR\r\n';
const SD = (input) => run('school_day.js', { Config: [{ timezone: 'Europe/Paris' }] }, input)[0].json;
o = SD({ data: ics });
ok(o.ok && o.classes.length === 4 && o.classes.map(c => c.start).join() === '08:00,10:15,13:30,15:00', "today's classes only, sorted, cancelled + tomorrow dropped");
ok(o.first.start === '08:00' && o.first.title === 'Maths' && o.first.room === 'B204', 'first class with room');
ok(o.classes[1].title === 'Physique, TD' && o.classes[1].room === 'A101', 'folded lines + escapes decoded');
ok(o.breaks.length === 1 && o.breaks[0].from === '10:00' && o.breaks[0].to === '10:15' && o.breaks[0].minutes === 15, 'short break found');
ok(o.lunch.from === '12:00' && o.lunch.to === '13:30' && o.resume.time === '13:30' && o.resume.room === 'Lab 3', 'lunch break + when classes start again');
ok(o.finish === '17:00', 'when classes finish');
o = SD({ data: 'BEGIN:VCALENDAR\r\n' + `BEGIN:VEVENT\r\nDTSTART:${ymd}T070000Z\r\nDTEND:${ymd}T090000Z\r\nSUMMARY:UTC\r\nEND:VEVENT\r\nEND:VCALENDAR` });
ok(o.classes.length === 1 && o.classes[0].start === new Date(`${todayParis}T07:00:00Z`).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }), 'UTC (Z) times converted to local');
o = SD({ data: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' });
ok(o.ok && o.classes.length === 0 && !o.first, 'no classes today → ok, empty');
ok(SD({ error: { message: 'Invalid URL' } }).ok === false && SD({}).error === 'no timetable configured', 'no / failed timetable → not ok, briefing still runs');

console.log('speak_sanitize');
const SP = (json) => run('speak_sanitize.js', {}, json)[0].json;
o = SP({ text: 'Hi 👋 **Sara**: see https://x.y/z or mail bob@ex.com now.', chatId: '111' });
ok(o.text === 'Hi Sara: see or mail now.' && o.chatId === '111', 'URL, email, emoji, markdown stripped; other fields kept');
ok(SP({ text: '- one\n• two\n* three' }).text === 'one two three', 'bullet markers stripped');
ok(SP({ text: 'Lunch at noon - then rest .' }).text === 'Lunch at noon, then rest.', 'inline dash → pause, no space before punctuation');
ok(SP({ text: 'Done ✅ , ok' }).text === 'Done, ok', 'no doubled punctuation after emoji removal');
ok(SP({ text: '  🎉🎉  ' }).text === '🎉🎉', 'nothing speakable → original trimmed text kept');
o = SP({ text: 'Read **this**', caption: '📅 **Card** https://x.y' });
ok(o.text === 'Read this' && o.caption === '📅 **Card** https://x.y', 'explicit caption left untouched');

console.log('clean_script');
const gem = text => ({ candidates: [{ content: { parts: [{ thought: true, text: 'thinking…' }, { text }] } }] });
const CL = (text, maxChars = 300) => run('clean_script.js', { Config: [{ maxChars }] }, gem(text))[0].json;
o = CL('Good  morning.\nNothing today.');
ok(o.text === 'Good morning. Nothing today.' && o.script === o.text && o.chars === o.text.length, 'thoughts skipped, whitespace collapsed');
o = CL('First sentence is here. Second sentence goes on and on.', 40);
ok(o.text === 'First sentence is here.', 'over budget → cut at last sentence end');
o = CL('one two three four five six seven eight nine ten', 20);
ok(o.text === 'one two three four.', 'no sentence end → cut at word, add period');
threw = false; try { run('clean_script.js', { Config: [{}] }, { candidates: [] }); } catch { threw = true; }
ok(threw, 'no text from Gemini → hard error');

console.log('normalize_email (university IMAP)');
const NE = (...items) => {
  const $input = items;
  return new Function('$input', fs.readFileSync(S + 'unimail/normalize_email.js', 'utf8'))({ all: () => $input.map(json => ({ json })) });
};
o = NE({ textPlain: 'Bonjour,\r\n\r\n\r\n\r\nRendu du  TP lundi.\u0000', textHtml: '<p>ignored</p>', from: '"Scolarité" <scol@univ-lemans.fr>', to: 'me@etu.univ-lemans.fr',
  subject: 'Rendu TP', date: 'Thu, 26 Nov 2026 09:15:00 +0100', metadata: { 'message-id': '<abc@univ-lemans.fr>' }, attributes: { uid: 7 } });
ok(o.length === 1 && o[0].json.body === 'Bonjour,\n\nRendu du TP lundi.' && o[0].json.messageId === '<abc@univ-lemans.fr>', 'plain text preferred, whitespace + NUL cleaned, Message-ID kept');
ok(o[0].json.receivedAt === '2026-11-26T08:15:00.000Z' && o[0].json.from.includes('scol@univ-lemans.fr'), 'date → ISO UTC, sender kept');
o = NE({ textHtml: '<style>p{}</style><p>Cours annul&eacute;?</p><p>Salle &#233;tage 2 &amp; B&lt;1&gt;</p><script>x()</script>', subject: 'Info', date: 'garbage', metadata: { 'Message-ID': '<h@x>' } });
ok(o[0].json.body === 'Cours annul&eacute;?\nSalle étage 2 & B<1>' && o[0].json.messageId === '<h@x>', 'HTML-only → text, entities decoded, scripts/styles dropped, header case-insensitive');
ok(!Number.isNaN(Date.parse(o[0].json.receivedAt)), 'bad date → now()');
o = NE({ textPlain: 'x', subject: 'S', from: 'a@b', date: 'Thu, 26 Nov 2026 09:15:00 +0100' });
ok(o[0].json.messageId.startsWith('no-id:2026-11-26T08:15:00.000Z:a@b:S'), 'missing Message-ID → stable fallback id');
ok(NE({}, null).length === 0, 'empty items skipped');
ok(NE({ textPlain: 'y'.repeat(30000), subject: 's' })[0].json.body.length === 20000, 'body capped at 20k chars');

console.log('build_prompt (briefing)');
const noSchool = { ok: false, error: 'no timetable configured', classes: [] };
const BP = (uni, style = { style: null, body: null }, school = noSchool, tasks = [{}]) => run('build_prompt.js', {
  Config: [{ maxChars: 300, language: 'English', timezone: 'Europe/Paris' }],
  'Get today events': [{}], 'Get priority emails': [{}], 'Get uni emails': uni, 'Get style': [style],
  'School day': [school], 'Get open tasks': tasks,
})[0].json;
const sysText = b => b.geminiRequest.systemInstruction.parts[0].text;
o = BP([{ id: 3, from_addr: '"Scolarité" <scol@univ-lemans.fr>', subject: 'Rendu TP', preview: 'Rendu  lundi' }]);
const ut = o.geminiRequest.contents[0].parts[0].text;
ok(o.uniEmailCount === 1 && /UNIVERSITY EMAILS, LAST 24 HOURS \(1\):\n- From: Scolarité \| Subject: Rendu TP \| Preview: Rendu lundi/.test(ut), 'uni emails listed in prompt');
ok(BP([{}]).uniEmailCount === 0 && BP([{ error: { message: 'relation does not exist' } }]).uniEmailCount === 0, 'empty / errored uni query → none, briefing still built');
ok(!/ANSWER STYLE/.test(sysText(BP([{}]))), 'no style chosen → default briefing prompt');
o = BP([{}], { style: 'butler', body: '  Be a discreet butler.  ' + 'x'.repeat(3000) });
ok(/ANSWER STYLE chosen by the user \("butler"\)[\s\S]*rules above still win\.\nBe a discreet butler\./.test(sysText(o)) && sysText(o).length < 3500, 'chosen style → appended after the rules, body capped');
ok(!/ANSWER STYLE/.test(sysText(BP([{}], { error: { message: 'relation does not exist' } }))) && !/ANSWER STYLE/.test(sysText(BP([{}], {}))), 'errored / empty style lookup → default prompt, briefing still built');

const userOf = b => b.geminiRequest.contents[0].parts[0].text;
o = BP([{}], undefined, SD({ data: ics }), [
  { id: 't1', title: 'Rendre le TP', status: 'needsAction', due: `${todayParis}T00:00:00.000Z` },
  { id: 't2', title: 'Old thing', status: 'needsAction', due: '2026-01-01T00:00:00.000Z' },
  { id: 't3', title: 'Someday', status: 'needsAction' },
  { id: 't4', title: 'Done one', status: 'completed', due: `${todayParis}T00:00:00.000Z` },
]);
ok(/SCHOOL TIMETABLE TODAY \(4 classes\):\n- First class: 08:00, Maths, room B204/.test(userOf(o))
  && /- Break: 10:00-10:15 \(15 min\)/.test(userOf(o))
  && /- Lunch break: 12:00-13:30, classes start again at 13:30, room Lab 3/.test(userOf(o))
  && /- Classes finish at: 17:00/.test(userOf(o)) && o.classCount === 4, 'school day in the briefing prompt');
ok(/TO-DO LIST \(2 due today or overdue, 3 open\):\n- Old thing \(overdue\)\n- Rendre le TP \(due today\)\n- plus 1 other open task/.test(userOf(o)) && o.dueTaskCount === 2, 'tasks: overdue + due today named, others counted, completed skipped');
o = BP([{}]);
ok(/SCHOOL TIMETABLE TODAY \(0 classes\):\n- no timetable configured/.test(userOf(o)) && /TO-DO LIST \(0 due today or overdue, 0 open\):\n- none/.test(userOf(o)), 'no timetable / no tasks → said plainly, briefing still built');
ok(/SCHOOL TIMETABLE TODAY \(0 classes\):\n- no classes today/.test(userOf(BP([{}], undefined, { ok: true, classes: [] }))), 'no classes today');

console.log(`\n${pass} passed`);
