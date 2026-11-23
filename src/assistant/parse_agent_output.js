// Code node "Parse + validate" (Run Once for All Items)
// The agent can only *describe* suggestions. This deterministic step decides
// which of them are well-formed enough to show you. Nothing here executes them.

const ctx = $('Prepare agent input').first().json;
const tz = $env.GENERIC_TIMEZONE || 'Europe/Paris';
const MAX_PROPOSALS = 3;
const raw = String($input.first().json.output ?? '');

function extractJson(s) {
  const t = s.replace(/```(?:json)?/gi, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

const clean = (v, max) => String(v ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const HAS_OFFSET = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
const fmtDay = d => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz });
const fmtTime = d => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });

function validate(p) {
  if (!p || typeof p !== 'object') return { error: 'not an object' };
  if (p.type !== 'calendar_event') return { error: `unsupported type ${p.type}` };

  const title = clean(p.title, 120);
  if (!title) return { error: 'missing title' };

  const startStr = String(p.start || '').trim();
  const endStr = String(p.end || '').trim();
  if (!HAS_OFFSET.test(startStr) || !HAS_OFFSET.test(endStr)) return { error: 'dates need a timezone offset' };

  const start = new Date(startStr);
  const end = new Date(endStr);
  if (isNaN(start) || isNaN(end)) return { error: 'invalid date' };
  if (end <= start) return { error: 'end before start' };
  if (end - start > 12 * 3600e3) return { error: 'longer than 12 hours' };

  const now = Date.now();
  if (start.getTime() < now - 3600e3) return { error: 'in the past' };
  if (start.getTime() > now + 366 * 86400e3) return { error: 'more than a year ahead' };

  const location = clean(p.location, 150);
  const description = clean(p.description, 500);
  const reason = clean(p.reason, 200);

  const sameDay = fmtDay(start) === fmtDay(end);
  const when = sameDay
    ? `${fmtDay(start)}, ${fmtTime(start)}–${fmtTime(end)}`
    : `${fmtDay(start)} ${fmtTime(start)} → ${fmtDay(end)} ${fmtTime(end)}`;

  const summary = [
    `📅 ${title}`,
    `🕒 ${when}`,
    location && `📍 ${location}`,
    reason && `💡 ${reason}`,
  ].filter(Boolean).join('\n');

  return {
    value: {
      kind: 'calendar_event',
      // The payload is the ONLY thing used when you tap Approve.
      payload: { title, start: start.toISOString(), end: end.toISOString(), location, description },
      summary,
    },
  };
}

const parsed = extractJson(raw);
let reply = '';
let proposals = [];

if (parsed && typeof parsed === 'object') {
  reply = String(parsed.reply ?? '');
  proposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];
} else {
  reply = raw; // model ignored the JSON format: still answer, but propose nothing
}

const valid = [];
const rejected = [];
for (const p of proposals.slice(0, 10)) {
  const r = validate(p);
  if (r.value && valid.length < MAX_PROPOSALS) valid.push(r.value);
  else if (r.error) rejected.push(r.error);
}

reply = reply
  .replace(/https?:\/\/\S+/gi, '')
  .replace(/[*_#`]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 1500);

if (!reply) reply = valid.length ? 'I have a suggestion for you.' : "Sorry, I couldn't put an answer together.";
if (rejected.length) reply += ` (I dropped ${rejected.length} suggestion${rejected.length > 1 ? 's' : ''} that had invalid details.)`;

return [{
  json: {
    chatId: ctx.chatId,
    inputMode: ctx.inputMode,
    replyRoute: ctx.inputMode === 'voice' ? 0 : 1,  // 0 = voice reply, 1 = text reply
    text: reply,                                     // "Speak" sub-workflow input contract
    reply,
    proposals: valid,
    rejectedProposals: rejected,
  },
}];
