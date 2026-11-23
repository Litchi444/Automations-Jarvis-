import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import fs from 'fs';
const P = new URL('..', import.meta.url).pathname;
const sql = f => fs.readFileSync(P + 'src/assistant/sql/' + f, 'utf8');
const db = new EmbeddedPostgres({ databaseDir: fs.mkdtempSync('/tmp/mb-pg-'), user: 'n8n', password: 'pw', port: 54329, persistent: false });
const ok = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('  ✓', m); };
await db.initialise(); await db.start();
try {
  const mk = () => { const c = new pg.Client({ host: 'localhost', port: 54329, user: 'n8n', password: 'pw', database: 'postgres' }); return c; };
  const c = mk(); await c.connect();
  // n8n stringifies objects in queryReplacement arrays
  const q = (s, params) => c.query(s, params.map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : v));
  await c.query(fs.readFileSync(P + 'docker/postgres/init/01-assistant.sql', 'utf8'));
  await c.query(fs.readFileSync(P + 'docker/postgres/init/01-assistant.sql', 'utf8'));
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
  console.log((await c.query('select id,status from assistant.decision_log')).rows.map(x => `${x.id}:${x.status}`).join(' '));
  await c.end();
} finally { await db.stop(); }
