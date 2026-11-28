// Code node "Parse + validate" (Run Once for All Items)
// The agent can only *describe* actions. This deterministic step decides which of
// them are well-formed, and whether one may run instantly (task_add / task_done the
// user asked for, see INSTANT) or needs a tap on a card. Nothing here executes them.

const ctx = $('Prepare agent input').first().json;
const tz = $env.GENERIC_TIMEZONE || 'Europe/Paris';
const MAX_PROPOSALS = 3;
const REPLY = { voice: 0, text: 1 };   // must match REPLY in src/build_workflows.py
const raw = String($input.first().json.output ?? '');

// Models often put raw line breaks inside JSON strings (e.g. an email draft),
// which JSON.parse rejects. Escape control characters that sit inside strings.
function escapeControlCharsInStrings(s) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      else if (ch < ' ') {
        out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t'
          : '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
        continue;
      }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function extractJson(s) {
  const t = s.replace(/```(?:json)?/gi, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  const body = t.slice(a, b + 1);
  try { return JSON.parse(body); } catch { /* try the lenient pass */ }
  try { return JSON.parse(escapeControlCharsInStrings(body)); } catch { return null; }
}

const clean = (v, max) => String(v ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const HAS_OFFSET = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{1,256}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{6,64}$/;   // Gmail message id (from "Gmail: search")
const EMAIL = /^[^\s@<>"(),;:]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/;
const fmtDay = d => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz });
const fmtTime = d => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
const localDate = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD

// The instant gate. task_add / task_done run without a tap ONLY when the user's own
// message (typed, or the voice transcript) is about their to-do list. The agent cannot
// open this gate: it is plain code over the user's words, so an email that tells the
// agent to add a task still ends up as a card to approve.
const words = list => new RegExp('(?<![\\p{L}\\p{N}])(?:' + list.join('|') + ')(?![\\p{L}\\p{N}])', 'iu');
const TASK_WORDS = words(['to[ -]?do(?:[ -]?lists?)?', 'tdl', 'tasks?', 't[âa]ches?', '[àa] faire',
  'ma liste', 'my list', 'checklist']);
const DONE_WORDS = words(['done', 'finished', 'completed?', 'check(?:ed)? off', 'tick(?:ed)? off',
  'fait', 'faite?s?', 'fini[es]?', 'termin[ée]e?s?', 'coch[eé]r?', 'barr[eé]r?']);
const userText = String(ctx.userText || '');
const INSTANT = {
  task_add: TASK_WORDS.test(userText),
  task_done: TASK_WORDS.test(userText) || DONE_WORDS.test(userText),
};

// A timed range shared by calendar_event and event_move.
function timeRange(startIn, endIn) {
  const startStr = String(startIn || '').trim();
  const endStr = String(endIn || '').trim();
  if (!HAS_OFFSET.test(startStr) || !HAS_OFFSET.test(endStr)) return { error: 'dates need a timezone offset' };
  const start = new Date(startStr);
  const end = new Date(endStr);
  if (isNaN(start) || isNaN(end)) return { error: 'invalid date' };
  if (end <= start) return { error: 'end before start' };
  if (end - start > 12 * 3600e3) return { error: 'longer than 12 hours' };
  const now = Date.now();
  if (start.getTime() < now - 3600e3) return { error: 'in the past' };
  if (start.getTime() > now + 366 * 86400e3) return { error: 'more than a year ahead' };
  const sameDay = fmtDay(start) === fmtDay(end);
  const when = sameDay
    ? `${fmtDay(start)}, ${fmtTime(start)}–${fmtTime(end)}`
    : `${fmtDay(start)} ${fmtTime(start)} → ${fmtDay(end)} ${fmtTime(end)}`;
  return { start, end, when };
}

// When an existing event starts: a timed ISO instant, or YYYY-MM-DD for an all-day event.
function eventStart(v) {
  const s = String(v || '').trim();
  if (DATE_ONLY.test(s)) {
    const noon = new Date(s + 'T12:00:00Z');
    return isNaN(noon) ? null : { value: s, allDay: true, label: `${fmtDay(noon)}, all day` };
  }
  if (!HAS_OFFSET.test(s) || isNaN(new Date(s))) return null;
  const d = new Date(s);
  return { value: d.toISOString(), allDay: false, label: `${fmtDay(d)}, ${fmtTime(d)}` };
}

function validate(p) {
  if (!p || typeof p !== 'object') return { error: 'not an object' };
  const title = clean(p.title, 120);
  const reason = clean(p.reason, 200);
  const why = reason && `💡 ${reason}`;
  if (!title) return { error: 'missing title' };
  const card = lines => lines.filter(Boolean).join('\n');

  // Each payload is the ONLY thing used when the action runs (after a tap, or instantly).
  switch (p.type) {
    case 'calendar_event': {
      const r = timeRange(p.start, p.end);
      if (r.error) return r;
      const location = clean(p.location, 150);
      const description = clean(p.description, 500);
      return { value: {
        kind: 'calendar_event',
        payload: { title, start: r.start.toISOString(), end: r.end.toISOString(), location, description },
        summary: card([`📅 ${title}`, `🕒 ${r.when}`, location && `📍 ${location}`, why]),
      } };
    }
    case 'event_move': {
      const eventId = String(p.eventId || '').trim();
      if (!EVENT_ID.test(eventId)) return { error: 'invalid event id' };
      const old = eventStart(p.oldStart);
      if (!old || old.allDay) return { error: 'oldStart needs a time with a timezone offset' };
      const r = timeRange(p.start, p.end);
      if (r.error) return r;
      return { value: {
        kind: 'event_move',
        payload: { eventId, title, oldStart: old.value, start: r.start.toISOString(), end: r.end.toISOString() },
        summary: card([`🔀 Move event: ${title}`, `🕒 From ${old.label}`, `➡️ To ${r.when}`, why]),
      } };
    }
    case 'event_delete': {
      const eventId = String(p.eventId || '').trim();
      if (!EVENT_ID.test(eventId)) return { error: 'invalid event id' };
      const at = eventStart(p.start);
      if (!at) return { error: 'invalid event start' };
      return { value: {
        kind: 'event_delete',
        payload: { eventId, title, start: at.value },
        summary: card([`🗑 Delete event: ${title}`, `🕒 ${at.label}`, why]),
      } };
    }
    case 'task_add': {
      let due = '';
      if (p.due != null && String(p.due).trim() !== '') {
        due = String(p.due).trim().slice(0, 10);
        const ms = new Date(due + 'T12:00:00Z').getTime();
        if (!DATE_ONLY.test(due) || isNaN(ms)) return { error: 'due must be YYYY-MM-DD' };
        if (ms < Date.now() - 2 * 86400e3 || ms > Date.now() + 366 * 86400e3) return { error: 'due date out of range' };
      }
      const notes = clean(p.notes, 500);
      const dueLabel = due && (due === localDate(Date.now()) ? 'today' : fmtDay(new Date(due + 'T12:00:00Z')));
      return { value: {
        kind: 'task_add',
        payload: { title, due, notes },
        summary: card([`📝 Add task: ${title}`, dueLabel && `📆 Due ${dueLabel}`, why]),
      } };
    }
    case 'task_done':
    case 'task_delete': {
      const taskId = String(p.taskId || '').trim();
      if (!TASK_ID.test(taskId)) return { error: 'invalid task id' };
      return { value: {
        kind: p.type,
        payload: { taskId, title },
        summary: card([p.type === 'task_done' ? `☑️ Mark done: ${title}` : `🗑 Delete task: ${title}`, why]),
      } };
    }
    case 'email_unsubscribe': {
      // Always a card (never instant). On approval the email is re-fetched by this id, its
      // sender must still be `from`, and only its RFC 8058 one-click header is used
      // (unsubscribe_target.js). The agent never supplies the unsubscribe link.
      const messageId = String(p.messageId || '').trim();
      if (!MESSAGE_ID.test(messageId)) return { error: 'invalid message id' };
      const rawFrom = String(p.from || '').trim();
      const from = (rawFrom.match(/<([^<>]*)>\s*$/)?.[1] ?? rawFrom).trim().toLowerCase();
      if (from.length > 254 || !EMAIL.test(from)) return { error: 'invalid sender address' };
      return { value: {
        kind: 'email_unsubscribe',
        payload: { messageId, from, title },
        summary: card([`📭 Unsubscribe: ${title}`, `✉️ ${from}`, why]),
      } };
    }
    default:
      return { error: `unsupported type ${p.type}` };
  }
}

const parsed = extractJson(raw);
let reply = '';
let proposals = [];
// Voice is the default reply. Text only when the agent says the user asked for it.
let wantsText = false;

if (parsed && typeof parsed === 'object') {
  reply = String(parsed.reply ?? '');
  proposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];
  wantsText = String(parsed.format ?? '').trim().toLowerCase() === 'text';
} else {
  reply = raw; // model ignored the JSON format: still answer, but propose nothing
}

const valid = [];
const rejected = [];
for (const p of proposals.slice(0, 10)) {
  const r = validate(p);
  if (r.value && valid.length < MAX_PROPOSALS) valid.push({ ...r.value, instant: INSTANT[r.value.kind] === true });
  else if (r.error) rejected.push(r.error);
}

reply = reply
  .replace(/https?:\/\/\S+/gi, '')
  .replace(/[*_#`]/g, '');
// Text replies (e.g. a drafted email) keep their line breaks and may be longer
// (Telegram caps a message at 4096 chars). Voice replies are one spoken paragraph.
reply = wantsText
  ? reply
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 3500)
  : reply
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);

if (!reply) reply = valid.length ? 'I have a suggestion for you.' : "Sorry, I couldn't put an answer together.";
if (rejected.length) reply += ` (I dropped ${rejected.length} suggestion${rejected.length > 1 ? 's' : ''} that had invalid details.)`;

return [{
  json: {
    chatId: ctx.chatId,
    inputMode: ctx.inputMode,
    replyRoute: wantsText ? REPLY.text : REPLY.voice, // voice is the default
    text: reply,                                     // "Speak" sub-workflow input contract
    reply,
    proposals: valid,
    rejectedProposals: rejected,
  },
}];
