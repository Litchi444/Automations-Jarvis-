// Code node "School day" (Run Once for All Items)
// Input: "Get school timetable" (the school's ICS feed as text in `data`, or an error item).
// Works out today's class day in code, so the briefing never has to guess a time or a
// room: first class + room, breaks, lunch break, when classes start again, last class end.
// Output: { ok, error, classes, first, breaks, lunch, resume, finish }.

const cfg = $('Config').first().json;
const tz = cfg.timezone || 'Europe/Paris';
const MIN_BREAK_MIN = 10;          // shorter gaps are just a room change
const LUNCH = [11 * 60 + 30, 14 * 60]; // a break overlapping 11:30–14:00 is the lunch break

const res = $input.first().json || {};
const ics = typeof res.data === 'string' ? res.data : '';

function offsetMs(ms, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
}

function validZone(z) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; }
}

// DTSTART/DTEND value → epoch ms. "…Z" is UTC; TZID=… or floating is wall time in that zone.
function icsTime(value, params) {
  const m = String(value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { allDay: true };
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  if (z) return { ms: wall };
  const zone = params.TZID && validZone(params.TZID) ? params.TZID : tz;
  let t = wall - offsetMs(wall, zone);
  const again = wall - offsetMs(t, zone);
  if (again !== t) t = again; // DST edge
  return { ms: t };
}

const unescape = v => String(v || '')
  .replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1')
  .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

function parseEvents(text) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const [name, ...rawParams] = line.slice(0, i).split(';');
    const params = Object.fromEntries(rawParams.map(p => p.split('=')).map(([k, v]) => [k.toUpperCase(), String(v || '').replace(/^"|"$/g, '')]));
    cur[name.toUpperCase()] = { value: line.slice(i + 1), params };
  }
  return events;
}

const hhmm = ms => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
const dayOf = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: tz });
const minutesOfDay = ms => { const [h, m] = hhmm(ms).split(':').map(Number); return h * 60 + m; };

const out = { ok: false, error: '', classes: [], first: null, breaks: [], lunch: null, resume: null, finish: null };

if (!/BEGIN:VCALENDAR/.test(ics)) {
  out.error = res.error ? 'timetable unavailable' : 'no timetable configured';
  return [{ json: out }];
}

const today = dayOf(Date.now());
const classes = parseEvents(ics)
  .filter(e => String(e.STATUS?.value || '').toUpperCase() !== 'CANCELLED' && e.DTSTART)
  .map(e => {
    const s = icsTime(e.DTSTART.value, e.DTSTART.params);
    const en = e.DTEND ? icsTime(e.DTEND.value, e.DTEND.params) : null;
    if (!s || s.allDay || !s.ms) return null;
    return {
      startMs: s.ms,
      endMs: en && en.ms > s.ms ? en.ms : s.ms + 3600e3,
      title: unescape(e.SUMMARY?.value).slice(0, 100) || 'Class',
      room: unescape(e.LOCATION?.value).slice(0, 60),
    };
  })
  .filter(c => c && dayOf(c.startMs) === today)
  .sort((a, b) => a.startMs - b.startMs)
  .slice(0, 20);

out.ok = true;
out.classes = classes.map(c => ({ start: hhmm(c.startMs), end: hhmm(c.endMs), title: c.title, room: c.room }));
if (!classes.length) return [{ json: out }];

out.first = out.classes[0];

// Gaps between the end of everything so far and the next class.
const gaps = [];
let busyUntil = classes[0].endMs;
for (const c of classes.slice(1)) {
  if (c.startMs - busyUntil >= MIN_BREAK_MIN * 60e3) gaps.push({ fromMs: busyUntil, toMs: c.startMs, next: c });
  busyUntil = Math.max(busyUntil, c.endMs);
}
out.finish = hhmm(busyUntil);

const overlap = g => Math.max(0, Math.min(minutesOfDay(g.toMs), LUNCH[1]) - Math.max(minutesOfDay(g.fromMs), LUNCH[0]));
const lunchGap = gaps.filter(g => overlap(g) > 0).sort((a, b) => overlap(b) - overlap(a))[0] || null;

const asBreak = g => ({ from: hhmm(g.fromMs), to: hhmm(g.toMs), minutes: Math.round((g.toMs - g.fromMs) / 60e3) });
if (lunchGap) {
  out.lunch = asBreak(lunchGap);
  out.resume = { time: hhmm(lunchGap.next.startMs), title: lunchGap.next.title, room: lunchGap.next.room };
}
out.breaks = gaps.filter(g => g !== lunchGap).map(asBreak);

return [{ json: out }];
