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

  console.log((await c.query('select id,status from assistant.decision_log')).rows.map(x => `${x.id}:${x.status}`).join(' '));
  await c.end();
} finally { await db.stop(); }
