# CR-1: Film-style "Jarvis" voice + Gmail unsubscribe
status: draft · requested: 2026-11-28 · owner: manager

## Request (user's words, one or two lines)
1. Give Jarvis a way of talking that mimics the Jarvis seen in the films (user will supply an MD summary).
2. Jarvis could not unsubscribe from promotional mailing lists. Clarify what it may do with Gmail and add unsubscribe.

---

## Part A: "jarvis" answer style

### Design-rule check
- [x] No: text only. A new `styles/*.md` file plus, optionally, a TTS tone string. No new tool.

### Current state
- Styles: `styles/butler.md`, `coach.md`, `concise.md` → build → `docker/postgres/init/03-styles.sql`.
- User picks with `/style <name>`; default is "none" (plain STYLE section of `system_message.txt`).
- Style never overrides CAPABILITIES / SAFETY / OUTPUT or the voice-note rules (≤ 600 chars, no markdown, no URLs).
- TTS tone is global: `ttsStyle = "Read this in a calm, warm, natural voice"` (`src/build_workflows.py:184`), voice Enceladus.

### Decisions (2026-11-28, user's `JARVIS_STYLE.md`)
- Address: "sir" in English, "Monsieur" in French. `jarvis` is the DEFAULT style.
- Done: `styles/jarvis.md` (guide condensed to the 2000-char style limit, film-specific examples dropped, adapted so it never claims an unapproved action was done); `load_style.sql` falls back to `jarvis`; `/style` list marks it "(default)"; `/style off` = back to jarvis. Tests updated. Deployed 2026-11-28.

### Tasks
| # | Task | Files | Tests | Acceptance |
|---|---|---|---|---|
| A1 | Turn the user's MD into a style: traits and rules (tone, dry wit, brevity, address form, FR "vous" / EN register), no quoted film lines | `styles/jarvis.md` | build regenerates `03-styles.sql`; existing style tests | `/style` lists `jarvis`; `/style jarvis` loads it |
| A2 | (only if chosen as default) default style for the chat | `src/assistant/sql/load_style.sql` or `01-assistant.sql` seed | SQL test for default | New chat answers in Jarvis style without `/style` |
| A3 | (optional) TTS tone closer to the character: e.g. "calm, composed, quietly witty British butler" | `src/build_workflows.py` (`ttsStyle`) | build + tests | Voice note tone checked by ear |

Out of scope: per-style TTS tone (would need a new style field, column and speak-workflow input). Revisit only if A3 is not enough.

### Deploy
- Apply `03-styles.sql`. Re-import the assistant only if A2/A3 touched it (re-import unlinks credentials: relink, re-publish).

---

## Part B: Gmail permissions and unsubscribe

### What Jarvis can do today
| Mailbox | Agent can | Agent cannot |
|---|---|---|
| Gmail | `Gmail: search` (10 results), `Gmail: read email` (full message, headers included) | send, reply, label, archive, delete, unsubscribe, create filters |
| University (univ-lemans.fr) | search / read the Postgres copy | anything on the mailbox (IMAP `postProcessAction: "nothing"`) |
| Briefing | reads priority emails | — |

Why unsubscribe failed: by the design rule the agent has read-only tools only, and no proposal kind exists for mail. The Gmail API itself has no "unsubscribe" call: unsubscribing means acting on the sender's `List-Unsubscribe` header (an HTTPS link or a mailto address).

### Design-rule check
- [x] Yes → new proposal kind `email_unsubscribe`: agent JSON → `parse_agent_output.js` → `assistant.proposals` → card → `claim_decision.sql` → plain node using the STORED payload. Never instant (not undoable).

### Proposed flow
1. User: "unsubscribe me from X". Agent searches Gmail, reads one message from X, proposes `{type: "email_unsubscribe", messageId, from, subject, reason}`.
2. Card: "Unsubscribe from <sender> (<from address>)? Link domain: <host>".
3. On approval, a plain node re-fetches the message by the stored `messageId` and checks the `From` still matches the card (same pattern as `verify_target.js`).
4. It parses `List-Unsubscribe` / `List-Unsubscribe-Post` and acts only on **RFC 8058 one-click**: HTTPS URL + `List-Unsubscribe=One-Click` → POST that body. Nothing is opened in a browser, no link from the body is followed.
5. No one-click header → mark failed and reply "no automatic unsubscribe for this sender, use Gmail's Unsubscribe button".

### Safety constraints (the URL comes from untrusted email)
- HTTPS only, from the header only, never from the email body or from the agent.
- SSRF guard: refuse IP literals, `localhost`, single-label hosts and the stack's own hostnames (`postgres`, `n8n`, …); no redirects followed; short timeout.
- mailto unsubscribe is NOT done: it sends an email, which the design rule forbids unless the user explicitly asks for it.
- One proposal per sender; the agent never re-generates the payload after approval.

### Decisions
- 2026-11-28, user: **one-click unsubscribe only (B1)**. No "mute sender" Gmail filter, no new Gmail scope, no mailto unsubscribe.
- Built 2026-11-28 (B1.1–B1.5): validator kind, schema, `unsubscribe_target.js` (regex URL check, no `URL` global), nodes Get email → Check unsubscribe → One-click unsubscribe, audit rule, prompt, README §5c. Card shows sender only (link host checked after approval). Deployed 2026-11-28.

### Tasks (B1)
| # | Task | Files | Tests | Acceptance |
|---|---|---|---|---|
| B1.1 | Validator: `email_unsubscribe` type, fields, limits, card summary | `src/assistant/parse_agent_output.js` | unit tests: valid, missing id, extra fields, not in INSTANT gate | Bad payloads rejected; never instant |
| B1.2 | Schema: allow the new kind | `docker/postgres/init/01-assistant.sql` (CHECK + idempotent ALTER) | SQL test | Insert of new kind succeeds on fresh and existing DB |
| B1.3 | Unsubscribe logic: header parsing, one-click check, SSRF guard, From match | new `src/assistant/unsubscribe_target.js` | unit tests: one-click OK, mailto-only refused, http refused, IP / localhost / `postgres` refused, From mismatch refused | Only safe one-click POSTs leave the stack |
| B1.4 | Wiring: route kind after "Approved?" → Gmail get (stored id) → B1.3 → HTTP POST → mark executed/failed; audit rule | `src/build_workflows.py`, `scripts/audit-invariants.py` | audit PASS; mocks by node name | Agent still has no write tools; POST uses only the checked URL |
| B1.5 | Prompt + docs: OUTPUT section, CAPABILITIES line, README | `src/assistant/system_message.txt`, `README.md` | build | Agent proposes the card instead of saying it can't |

### After the build tasks (both parts)
- `python3 src/build_workflows.py`, `cd tests && npm test`, `npm run lint`, `ruff check src scripts`, `python3 scripts/audit-invariants.py` all PASS.
- qa-reviewer: acceptance + audit. infra-deployer: schema/styles SQL. n8n-operator: re-import, relink creds, re-publish, restart.
- Live test: `/style jarvis` reply + voice note; unsubscribe card on a real promo mail with one-click header, and on one without (must refuse cleanly).
