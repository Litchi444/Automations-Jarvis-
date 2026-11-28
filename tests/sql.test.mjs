import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
// fileURLToPath + os.tmpdir keep this runnable on Windows as well as Linux/macOS.
const P = fileURLToPath(new URL('..', import.meta.url));
const sql = f => fs.readFileSync(path.join(P, 'src/assistant/sql', f), 'utf8');
const db = new EmbeddedPostgres({ databaseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mb-pg-')), user: 'n8n', password: 'pw', port: 54329, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
const ok = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('  ✓', m); };
await db.initialise(); await db.start();
try {
  // Swallow socket errors raised when the server stops after a failure, so the real error is reported.
  const mk = () => { const c = new pg.Client({ host: 'localhost', port: 54329, user: 'n8n', password: 'pw', database: 'postgres' }); c.on('error', () => {}); return c; };
  const c = mk(); await c.connect();
  // n8n stringifies objects in queryReplacement arrays
  const q = (s, params) => c.query(s, params.map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : v));
  await c.query(fs.readFileSync(path.join(P, 'docker/postgres/init/01-assistant.sql'), 'utf8'));
  await c.query(fs.readFileSync(path.join(P, 'docker/postgres/init/01-assistant.sql'), 'utf8'));
  ok(true, 'init SQL runs twice (idempotent)');
  const payload = { title: 'Dentist', start: '2026-11-27T14:00:00.000Z', end: '2026-11-27T15:00:00.000Z', location: '', description: '' };
  const ins = async (chat = '111', ttl = 12) => (await q(sql('insert_proposal.sql'), [chat, 'calendar_event', payload, '📅 Dentist', ttl])).rows[0];
  const claim = (id, action, chat = '111', client = c) => client.query(sql('claim_decision.sql'), [String(id), action, chat]).then(r => r.rows);

  const a = await ins();
  ok(a.id && a.chat_id === '111' && a.summary === '📅 Dentist', 'insert returns id, chat_id, summary');
  let r = await claim(a.id, 'approve');
  ok(r.length === 1 && r[0].ok === true && r[0].status === 'approved' && r[0].payload.title === 'Dentist', 'approve → ok, approved, payload as jsonb object');
  r = await claim(a.id, 'approve');
  ok(r.length === 1 && r[0].ok === false && r[0].status === 'approved', 'second tap → refused, shows current status');
  r = await q(sql('mark_executed.sql'), [String(a.id), { eventId: 'evt1', link: 'https://cal/x' }]);
  ok(r.rows[0].editText.includes('✅ Added') && r.rows[0].toast, 'mark executed returns card text + toast');
  r = await claim(a.id, 'decline');
  ok(r[0].ok === false && r[0].status === 'executed', 'decline after execution → refused (executed)');

  const b = await ins(); r = await claim(b.id, 'decline');
  ok(r[0].ok === true && r[0].status === 'declined', 'decline → declined');

  const e = await ins('111', 0);
  r = await claim(e.id, 'approve');
  ok(r.length === 1 && r[0].ok === false && r[0].status === 'expired', 'expired card → marked expired, not approved');
  const st = (await c.query('select status from assistant.proposals where id=$1', [e.id])).rows[0].status;
  ok(st === 'expired', 'expired status persisted');

  const w = await ins('222'); r = await claim(w.id, 'approve', '111');
  ok(r.length === 0, 'other chat id → no rows (cannot touch it)');
  r = await claim(999999, 'approve');
  ok(r.length === 0, 'unknown id → no rows');

  const f = await ins(); await claim(f.id, 'approve');
  r = await q(sql('mark_failed.sql'), [String(f.id), 'Calendar API 403']);
  ok(r.rows[0].editText.includes('Could not add it: Calendar API 403'), 'mark failed → error shown on card');

  // Race: two taps at the same time on separate connections
  const g = await ins(); const c2 = mk(); await c2.connect(); const c3 = mk(); await c3.connect();
  const [r1, r2] = await Promise.all([claim(g.id, 'approve', '111', c2), claim(g.id, 'approve', '111', c3)]);
  const wins = [...r1, ...r2].filter(x => x.ok).length;
  ok(wins === 1, `concurrent double-tap → exactly one winner (got ${wins}); loser sees: ${[...r1, ...r2].filter(x => !x.ok).map(x => x.status).join(',') || 'nothing'}`);
  await c2.end(); await c3.end();
  // University mailbox copy
  const uIns = (mid, subject, body, when = new Date().toISOString(), from = '"Scolarité" <scol@univ-lemans.fr>') =>
    q(sql('insert_uni_email.sql'), [mid, from, 'me@etu.univ-lemans.fr', subject, body, when]).then(r => r.rows);
  const old = new Date(Date.now() - 200 * 86400e3).toISOString();
  await uIns('<old@x>', 'Ancien', 'vieux', old);
  let u = await uIns('<tp@x>', 'Rendu TP', 'Le TP 3 est à rendre lundi, 100% obligatoire.');
  ok(u.length === 1 && u[0].id, 'uni email inserted');
  ok((await uIns('<tp@x>', 'Rendu TP', 'dup')).length === 0, 'same Message-ID → ignored (idempotent)');
  ok((await c.query("select count(*)::int n from assistant.uni_emails where message_id='<old@x>'")).rows[0].n === 0, 'copies older than 180 days pruned');
  await uIns('<week@x>', 'Réunion', 'Amphi B', new Date(Date.now() - 10 * 86400e3).toISOString(), 'prof@univ-lemans.fr');
  const search = (t, d) => q(sql('search_uni_emails.sql'), [t, d]).then(r => r.rows);
  ok((await search('rendu', 7)).map(x => x.subject).join() === 'Rendu TP', 'search: case-insensitive match on subject, days window');
  ok((await search('', 30)).length === 2 && (await search('', 7)).length === 1, 'empty text → all within window');
  ok((await search('100%', 7)).length === 1 && (await search('_', 7)).length === 0, '% and _ are literal, not wildcards');
  ok((await search('PROF@', '')).length === 1 && (await search('x', 99999)).length === 0, 'sender match; empty days → 14 default; days capped');
  u = (await q(sql('read_uni_email.sql'), [String(u[0].id)])).rows;
  ok(u.length === 1 && u[0].body.includes('TP 3') && u[0].to_addr, 'read one email by id');
  ok((await c.query(sql('recent_uni_emails.sql'))).rows.map(x => x.subject).join() === 'Rendu TP', 'briefing: last 24 h only');

  // Writing skills (generated from skills/*.md)
  const skillsSql = fs.readFileSync(path.join(P, 'docker/postgres/init/02-skills.sql'), 'utf8');
  const nSkills = fs.readdirSync(path.join(P, 'skills')).filter(f => f.endsWith('.md')).length;
  await c.query(skillsSql); await c.query(skillsSql);
  const countSkills = async () => (await c.query('select count(*)::int n from assistant.skills')).rows[0].n;
  ok(await countSkills() === nSkills, `skills SQL runs twice (idempotent), ${nSkills} skill(s) loaded`);
  await c.query("insert into assistant.skills (name, description, body) values ('zz-test', 'Tweet 100% short', 'Body with ''quotes''')");
  let bad = false; try { await c.query("insert into assistant.skills (name, description, body) values ('Bad Name', 'd', 'b')"); } catch { bad = true; }
  ok(bad, 'skill name must be a lowercase slug');
  const list = f => q(sql('list_skills.sql'), [f]).then(r => r.rows);
  ok((await list('')).length === nSkills + 1 && (await list(''))[0].body === undefined, 'list: all skills, name + description only');
  ok((await list('TWEET')).map(x => x.name).join() === 'zz-test', 'list: case-insensitive filter');
  ok((await list('100%')).length === 1 && (await list('_')).length === 0, 'list: % and _ are literal');
  const readSkill = n => q(sql('read_skill.sql'), [n]).then(r => r.rows);
  ok((await readSkill('  ZZ-Test ')).map(x => x.body).join() === "Body with 'quotes'", 'read: by name, trimmed + lowercased');
  ok((await readSkill("zz-test' or '1'='1")).length === 0, 'read: unknown / injected name → no rows');
  await c.query(skillsSql);
  ok(await countSkills() === nSkills, 'skills SQL removes skills deleted from skills/');

  // Answer styles (generated from styles/*.md) + the /style command
  const stylesSql = fs.readFileSync(path.join(P, 'docker/postgres/init/03-styles.sql'), 'utf8');
  const styleNames = fs.readdirSync(path.join(P, 'styles')).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort();
  await c.query(stylesSql); await c.query(stylesSql);
  const countStyles = async () => (await c.query('select count(*)::int n from assistant.styles')).rows[0].n;
  ok(styleNames.length > 0 && await countStyles() === styleNames.length, `styles SQL runs twice (idempotent), ${styleNames.length} style(s) loaded`);
  bad = false; try { await c.query("insert into assistant.styles (name, description, body) values ('off', 'd', 'b')"); } catch { bad = true; }
  ok(bad, "'off' is reserved, not a style name");
  const setStyle = (arg, chat = '111') => q(sql('set_style.sql'), [chat, arg]).then(r => r.rows);
  const loadStyle = (chat = '111') => q(sql('load_style.sql'), [chat]).then(r => r.rows);
  r = await loadStyle();
  ok(r.length === 1 && r[0].style === 'jarvis' && r[0].body.length > 0, 'load: no setting yet → one row, default style jarvis');
  r = await setStyle('');
  ok(r.length === 1 && r[0].reply.includes('Current style: default') && r[0].reply.includes('• jarvis (default): ') && styleNames.every(n => r[0].reply.includes(n)), '/style → lists every style + current');
  const pick = styleNames[0];
  r = await setStyle(`  ${pick.toUpperCase()} `);
  ok(r.length === 1 && r[0].reply.startsWith(`Style set: ${pick}.`), '/style <name> → set (trimmed, case-insensitive)');
  r = await loadStyle();
  ok(r.length === 1 && r[0].style === pick && r[0].body.length > 0, 'load: returns the chosen style body');
  ok((await loadStyle('222'))[0].style === 'jarvis', 'load: other chat unaffected');
  r = await setStyle("nope' or '1'='1");
  ok(r[0].reply.startsWith('Unknown style') && (await loadStyle())[0].style === pick, 'unknown / injected name → refused, setting unchanged');
  r = await setStyle('off');
  ok(r[0].reply === 'Style reset to the default.' && (await loadStyle())[0].style === 'jarvis', '/style off → back to default (jarvis)');
  r = await setStyle('off');
  ok(r[0].reply === 'Style reset to the default.', '/style off twice → still fine');
  await c.query("insert into assistant.styles (name, description, body) values ('zz-gone', 'temp', 'Temp body')");
  await setStyle('zz-gone');
  await c.query(stylesSql);
  r = await loadStyle();
  ok(r.length === 1 && r[0].style === 'jarvis' && await countStyles() === styleNames.length, 'style deleted from styles/ → chats using it fall back to default');

  // To-do list: instant task actions, kind-aware card texts, undo
  const inst = (kind, pl, chat = '111') => q(sql('insert_instant.sql'), [chat, kind, pl, `📝 ${pl.title}`]).then(r => r.rows);
  const t = (await inst('task_add', { title: 'Buy milk', due: '', notes: '' }))[0];
  ok(t && t.kind === 'task_add' && t.payload.title === 'Buy milk', 'instant task_add logged, payload as jsonb');
  ok((await c.query('select status, instant from assistant.proposals where id=$1', [t.id])).rows[0].instant === true, 'instant row marked instant + approved');
  ok((await inst('calendar_event', { title: 'x' })).length === 0 && (await inst('task_delete', { title: 'x' })).length === 0, 'instant insert refuses every other kind');
  r = (await q(sql('mark_executed.sql'), [String(t.id), { id: 'gt-1', title: 'Buy milk' }])).rows[0];
  ok(r.editText.endsWith('✅ Added to your tasks.') && r.undoable === true && r.id, 'instant executed → undoable, task text');
  const claimUndo = (id, chat = '111', client = c) => client.query(sql('claim_undo.sql'), [String(id), chat]).then(x => x.rows);
  ok((await claimUndo(t.id, '222')).length === 0, 'undo from another chat → no rows');
  r = await claimUndo(t.id);
  ok(r.length === 1 && r[0].ok === true && r[0].status === 'undone' && r[0].result.id === 'gt-1', 'undo claimed, stored task id returned');
  r = await claimUndo(t.id);
  ok(r[0].ok === false && r[0].status === 'undone', 'second undo tap → refused');
  r = (await q(sql('mark_undone.sql'), [String(t.id)])).rows[0];
  ok(r.editText.endsWith('↩️ Undone.'), 'mark undone → card text');
  const t2 = (await inst('task_done', { taskId: 'gt-2', title: 'Essay' }))[0];
  r = (await q(sql('mark_executed.sql'), [String(t2.id), { id: 'gt-2', title: 'Essay (final)' }])).rows[0];
  ok(r.editText.endsWith('✅ Done: Essay (final).'), 'task_done shows the real title Google returned');
  await claimUndo(t2.id);
  r = (await q(sql('mark_undo_failed.sql'), [String(t2.id), 'Tasks API 404'])).rows[0];
  ok(r.editText.includes('Could not undo it: Tasks API 404') && (await c.query('select status from assistant.proposals where id=$1', [t2.id])).rows[0].status === 'executed', 'undo failed → back to executed, error shown');
  await c.query("update assistant.proposals set decided_at = now() - interval '25 hours' where id=$1", [t2.id]);
  ok((await claimUndo(t2.id))[0].ok === false, 'undo after 24 h → refused');
  const card = await ins(); await claim(card.id, 'approve');
  await q(sql('mark_executed.sql'), [String(card.id), {}]);
  ok((await claimUndo(card.id))[0].ok === false, 'card (non-instant) actions cannot be undone');
  const del = (await q(sql('insert_proposal.sql'), ['111', 'task_delete', { taskId: 'gt-3', title: 'Essay' }, '🗑 Delete task: Essay', 12])).rows[0];
  await claim(del.id, 'approve');
  r = (await q(sql('mark_failed.sql'), [String(del.id), 'the task title changed'])).rows[0];
  ok(r.editText.includes('Could not delete it: the task title changed') && r.undoable === false, 'failed delete → kind-aware text, not undoable');
  const unsub = async () => (await q(sql('insert_proposal.sql'), ['111', 'email_unsubscribe', { messageId: 'm1', from: 'news@shop.fr', title: 'Shop' }, '📭 Unsubscribe: Shop', 12])).rows[0];
  const u1 = await unsub(); await claim(u1.id, 'approve');
  r = (await q(sql('mark_executed.sql'), [String(u1.id), {}])).rows[0];
  ok(r.editText.includes('📭 Unsubscribe request sent') && r.toast === 'Unsubscribed' && r.undoable === false, 'unsubscribe executed → card text, not undoable');
  const u2 = await unsub(); await claim(u2.id, 'approve');
  r = (await q(sql('mark_failed.sql'), [String(u2.id), 'no one-click unsubscribe'])).rows[0];
  ok(r.editText.includes('Could not unsubscribe: no one-click unsubscribe'), 'unsubscribe failed → kind-aware text');
  ok((await inst('email_unsubscribe', { messageId: 'm1' })).length === 0, 'unsubscribe can never be instant');
  bad = false; try { await q(sql('insert_proposal.sql'), ['111', 'send_email', {}, 's', 12]); } catch { bad = true; }
  ok(bad, 'unknown proposal kind rejected by the table');
  bad = false; try { await c.query("insert into assistant.proposals (chat_id, kind, payload, summary, instant) values ('1', 'task_delete', '{}', 's', true)"); } catch { bad = true; }
  ok(bad, 'instant is impossible for anything but task_add / task_done');

  console.log((await c.query('select id,status from assistant.decision_log')).rows.map(x => `${x.id}:${x.status}`).join(' '));

  // Upgrade path: a volume created before tasks existed (old inline CHECKs) accepts the new kinds.
  await c.query('DROP SCHEMA assistant CASCADE');
  await c.query(`CREATE SCHEMA assistant; CREATE TABLE assistant.proposals (
    id bigserial PRIMARY KEY, chat_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('calendar_event')), payload jsonb NOT NULL, summary text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'expired', 'executed', 'failed')),
    created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now() + interval '12 hours',
    decided_at timestamptz, result jsonb)`);
  await c.query(fs.readFileSync(path.join(P, 'docker/postgres/init/01-assistant.sql'), 'utf8'));
  ok((await inst('task_add', { title: 'After upgrade' })).length === 1, 'old volume + re-applied 01-assistant.sql → task kinds accepted');

  // Chat memory trim: the loaded window (last N rows) must open on a user turn.
  const msg = (s, type) => q('insert into public.assistant_chat_history (session_id, message) values ($1, $2)', [s, { type, data: { content: type } }]);
  const types = async s => (await c.query('select message->>\'type\' t from public.assistant_chat_history where session_id = $1 order by id', [s])).rows.map(x => x.t);
  const trim = (s, n) => q(sql('trim_chat_memory.sql'), [s, n]).then(r => r.rows);
  r = await trim('telegram-1', 6);
  ok(r.length === 1 && r[0].trimmed === 0, 'trim: empty history → one row, nothing deleted');
  // human, ai(tool call), tool, ai | human, ai(tool call), tool, ai | human, ai
  for (const t of ['human', 'ai', 'tool', 'ai', 'human', 'ai', 'tool', 'ai', 'human', 'ai']) { await msg('telegram-1', t); }
  await msg('telegram-2', 'ai');
  r = await trim('telegram-1', 8);   // window would open on "tool"
  ok(r[0].trimmed === 4 && (await types('telegram-1')).join() === 'human,ai,tool,ai,human,ai', 'trim: window cut inside a tool exchange → history starts at the oldest user turn in it');
  r = await trim('telegram-1', 24);
  ok(r[0].trimmed === 0 && (await types('telegram-1')).length === 6, 'trim: window already opens on a user turn → nothing deleted');
  ok((await types('telegram-2')).join() === 'ai', 'trim: other sessions untouched');
  r = await trim('telegram-2', 24);
  ok(r[0].trimmed === 1 && (await types('telegram-2')).length === 0, 'trim: no user turn in the window → window dropped');
  r = await trim("x' or '1'='1", 24);
  ok(r[0].trimmed === 0 && (await types('telegram-1')).length === 6, 'trim: injected session key → nothing deleted');
  await c.end();
} finally { await db.stop(); }
