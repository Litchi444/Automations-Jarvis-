// Code node "Check unsubscribe" (Run Once for All Items)
// Runs after an approved email_unsubscribe tap, on the Gmail message fetched by its STORED id.
// It throws (→ the node's error output marks the proposal failed) unless:
//   - the message still exists and its sender is the address shown on the card, and
//   - it carries an RFC 8058 one-click unsubscribe: "List-Unsubscribe-Post: List-Unsubscribe=One-Click"
//     plus an https link in "List-Unsubscribe".
// The link comes from the email headers only, never from the body or the agent. mailto
// links are never used (that would send an email). Output: { kind, payload, url, host }
// for "One-click unsubscribe", which POSTs the fixed one-click body to `url`.
//
// Network guard (the URL is untrusted): https only, port 443, no credentials, a public-looking
// DNS name (no IP literal, no single-label or local names such as "postgres" or "n8n").
// The HTTP node follows no redirects and validates TLS, so a name that resolves to a
// private address still cannot reach a stack service (none serves a valid cert for it).

const d = $('Decision outcome').first().json;
const p = d.payload || {};
const got = $input.first().json || {};

if (d.kind !== 'email_unsubscribe') throw new Error(`unexpected kind ${d.kind}`);
if (!got.id || got.id !== p.messageId) throw new Error('this email no longer exists');

const fromAddr = String(got.from?.value?.[0]?.address || '').trim().toLowerCase();
if (!fromAddr || fromAddr !== p.from) throw new Error('the sender changed since the card was made');

// n8n's Gmail "get" (simple: false) gives headers as { 'list-unsubscribe': 'List-Unsubscribe: <...>' }:
// lower-case keys, raw header lines. Accept a bare value too.
const headers = {};
for (const [k, v] of Object.entries(got.headers || {})) headers[k.toLowerCase()] = v;
function header(name) {
  const v = headers[name];
  if (v == null) return '';
  const s = (Array.isArray(v) ? v.join(', ') : String(v)).replace(/\s+/g, ' ').trim();
  return s.toLowerCase().startsWith(name + ':') ? s.slice(name.length + 1).trim() : s;
}

const NO_ONE_CLICK = "this sender has no one-click unsubscribe, use Gmail's Unsubscribe button instead";
if (header('list-unsubscribe-post').toLowerCase() !== 'list-unsubscribe=one-click') throw new Error(NO_ONE_CLICK);

// Strict shape, checked without the URL class (not a Code-node global): https, a host of
// letters/digits/dots/hyphens only (so no user:pass@, %-escapes, backslashes or [IPv6]),
// optional :443, then a path / query starting with / ? or #.
const HTTPS_URL = /^https:\/\/([A-Za-z0-9.-]+)(?::(\d{1,5}))?([/?#][^\s<>"\\]*)?$/;
const DNS_NAME = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const BLOCKED_HOST = /(?:^|\.)(?:localhost|localdomain|local|internal|lan|home\.arpa|test|invalid|example)$/;
function safeUrl(s) {
  if (s.length > 2048) return null;
  const m = HTTPS_URL.exec(s);
  if (!m || (m[2] && m[2] !== '443')) return null;
  const host = m[1].toLowerCase();
  // The top-level label must start with a letter: this refuses every numeric or hex IPv4
  // spelling (127.0.0.1, 2130706433, 0x7f.1) that an HTTP client would turn into an address.
  const tld = host.slice(host.lastIndexOf('.') + 1);
  if (!DNS_NAME.test(host) || !/^[a-z]/.test(tld) || /^0x/.test(tld) || BLOCKED_HOST.test(host)) return null;
  return { url: s, host };
}

const links = [...header('list-unsubscribe').matchAll(/<([^<>\s]+)>/g)].map(m => m[1]);
const https = links.filter(l => /^https:/i.test(l));
if (!https.length) throw new Error(NO_ONE_CLICK);
const target = safeUrl(https[0]);
if (!target) throw new Error('the unsubscribe link looks unsafe, use Gmail\'s Unsubscribe button instead');

return [{ json: { kind: d.kind, payload: p, url: target.url, host: target.host } }];
