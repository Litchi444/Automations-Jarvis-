// Code node: "Normalize email" (Run Once for All Items)
// Turns IMAP trigger items (format "simple": textPlain, textHtml, from, to, subject, date,
// metadata['message-id']) into rows for assistant.uni_emails.
// Mail content is untrusted: it is only cleaned and stored here, never interpreted.

const MAX_BODY = 20000;

const decodeEntities = s => s
  .replace(/&nbsp;/gi, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&amp;/gi, '&');

const htmlToText = html => decodeEntities(String(html || '')
  .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, '\n')
  .replace(/<[^>]+>/g, ' '));

// Postgres text rejects NUL; collapse layout whitespace but keep paragraph breaks.
const clean = (s, n) => String(s ?? '')
  .replace(/\u0000/g, '')
  .replace(/\r\n?/g, '\n')
  .replace(/[ \t\f\v]+/g, ' ')
  .replace(/ *\n */g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim()
  .slice(0, n);

const header = v => {
  if (Array.isArray(v)) return v.map(header).join(', ');
  if (v && typeof v === 'object') return String(v.text ?? v.value ?? '');
  return String(v ?? '');
};

const findHeader = (meta, name) => {
  const key = Object.keys(meta || {}).find(k => k.toLowerCase() === name);
  return key ? header(meta[key]) : '';
};

const rows = [];
for (const { json: m } of $input.all()) {
  if (!m || typeof m !== 'object') continue;
  const plain = String(m.textPlain || '').trim();
  const body = clean(plain || htmlToText(m.textHtml), MAX_BODY);
  const parsed = new Date(header(m.date));
  const receivedAt = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  const from = clean(header(m.from), 300);
  const subject = clean(header(m.subject), 500);
  const messageId = clean(findHeader(m.metadata, 'message-id'), 500)
    || clean(`no-id:${receivedAt}:${from}:${subject}`, 500);
  if (!body && !subject && !from) continue;
  rows.push({ json: { messageId, from, to: clean(header(m.to), 500), subject, body, receivedAt } });
}
return rows;
