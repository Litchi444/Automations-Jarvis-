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

console.log('proposals_to_items');
o = run('assistant/proposals_to_items.js', { 'Parse + validate': [{ chatId: '111', proposals: [{ kind: 'calendar_event', payload: { a: 1 }, summary: 's' }, { kind: 'calendar_event', payload: {}, summary: 't' }] }] });
ok(o.length === 2 && o[0].json.chatId === '111', 'one item per proposal');
ok(run('assistant/proposals_to_items.js', { 'Parse + validate': [{ chatId: '1', proposals: [] }] }).length === 0, 'no proposals → branch ends');

console.log('callback_outcome');
const C = (row) => run('assistant/callback_outcome.js', { 'Route update': [{ proposalId: '7' }] }, row)[0].json;
ok(C({ id: 7, ok: true, status: 'approved', summary: 'S', payload: { title: 'x' } }).route === 0, 'approved → create route');
ok(/❌ Declined/.test(C({ id: 7, ok: true, status: 'declined', summary: 'S' }).editText), 'declined → card updated');
ok(/Already declined/.test(C({ id: 7, ok: false, status: 'declined', summary: 'S' }).editText), 'tap on already-declined card → "already", not a fresh decline');
ok(/⌛ Expired/.test(C({ id: 7, ok: false, status: 'expired', summary: 'S' }).editText), 'expired → card updated');
ok(/Already being processed/.test(C({ id: 7, ok: false, status: 'pending', summary: 'S' }).editText), 'race loser → being processed');
ok(/Already executed/.test(C({ id: 7, ok: false, status: 'executed', summary: 'S' }).editText) && C({ id: 7, ok: false, status: 'executed' }).route === 1, 'double tap → no second create');
ok(/no longer exists/.test(C({}).editText), 'unknown proposal → handled');
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
const BP = uni => run('build_prompt.js', {
  Config: [{ maxChars: 300, language: 'English', timezone: 'Europe/Paris' }],
  'Get today events': [{}], 'Get priority emails': [{}], 'Get uni emails': uni,
})[0].json;
o = BP([{ id: 3, from_addr: '"Scolarité" <scol@univ-lemans.fr>', subject: 'Rendu TP', preview: 'Rendu  lundi' }]);
const ut = o.geminiRequest.contents[0].parts[0].text;
ok(o.uniEmailCount === 1 && /UNIVERSITY EMAILS, LAST 24 HOURS \(1\):\n- From: Scolarité \| Subject: Rendu TP \| Preview: Rendu lundi/.test(ut), 'uni emails listed in prompt');
ok(BP([{}]).uniEmailCount === 0 && BP([{ error: { message: 'relation does not exist' } }]).uniEmailCount === 0, 'empty / errored uni query → none, briefing still built');

console.log(`\n${pass} passed`);
