# Jarvis on n8n: Telegram voice assistant + morning briefing

A self-hosted personal assistant you talk to on Telegram, by voice or text. It reads your Google Calendar and Gmail. **It can suggest things but never act on its own:** every suggestion arrives as a card with **Approve / Decline** buttons, and only your tap creates anything.

Every day at 07:30 it also sends a short spoken briefing of your day.

## Fastest path: let the Claude Code agent team deploy it

```bash
cd morning-briefing
claude --agent manager
```

The **manager** reads `plan/STATUS.md` and runs the deployment one phase at a time. Each phase goes to a specialist subagent with its own small context. The manager pauses at the two steps only you can do (Google sign-in and credentials, then a live test from your phone).

| Agent | Model | Tools | Job |
|---|---|---|---|
| `manager` | inherit | spawns only the 4 below; Read/Write/Edit (plan files); AskUserQuestion; **no Bash** | Picks the next phase, delegates, records handoffs, stops at checkpoints |
| `infra-deployer` | sonnet | Bash, Read, Glob, Grep | `.env` checks, Docker build/start, schema, health |
| `workflow-builder` | inherit | Read, Write, Edit, Glob, Grep, Bash | Changes in `src/`, regenerates workflows, tests |
| `n8n-operator` | sonnet | Bash, Read, Grep | Import, publish, smoke test, webhook, executions |
| `qa-reviewer` | inherit | Read, Glob, Grep, Bash (**no Write/Edit**) | Verifies phases independently, final GO/NO-GO |

**Plan:** P1 preflight → P2 stack (+qa) → P3 import → **H1 you: credentials** → P4 publish + smoke (+qa) → **H2 you: phone test** → P5 final review. Files in `plan/`.

**How contexts stay small:**
- One fresh subagent per phase. Only a ≤25-line HANDOFF block carries forward.
- The manager never reads logs, code, or the 58 KB of generated workflow JSON.
- `scripts/` turn logs and APIs into PASS/FAIL lines (one execution dump: 400 KB → 300 bytes).
- `maxTurns` caps per agent. Phase files are ≤ 41 lines and list exactly which files to read.

**Safety rails:**
- `.claude/settings.json` denies reading `.env` and destructive Docker commands, and asks before builds, imports and publishes.
- `scripts/audit-invariants.py` mechanically checks that the AI never got write access. It catches 9/9 planted violations.

**Later features:** ask the manager (e.g. *"let Jarvis propose Google Tasks too"*). It writes a change request from `plan/CR-template.md` and splits it into ≤3-file builder tasks, each verified by qa. Requests that would let the AI act on its own get redesigned as approval cards.

## The three workflows

| Workflow | Trigger | Role |
|---|---|---|
| **Speak** (`workflow_speak.json`) | called by the other two | text → Gemini TTS → ffmpeg OGG/Opus → Telegram voice note (text fallback if it fails) |
| **Morning Briefing** | daily 07:30 | today's events + important unread mail → Gemini script → *Speak* |
| **Assistant (Jarvis)** | Telegram messages + button taps | conversation, read-only tools, approval cards |

### How the assistant works

```
You (voice/text) ─► Telegram Trigger ─► Route update (only YOUR private chat passes)
                                          │
        ┌──────────── voice ──────────────┼──────── text ────────┐        ┌── button tap ──┐
        ▼                                 │                      ▼        ▼                │
  download → Gemini transcribe ───────────┴──► Jarvis (AI Agent) ◄── memory (Postgres)    │
                                                  │  ▲ read-only tools:                   │
                                                  │  └ calendar list · Gmail search · read │
                                                  ▼                                        │
                                   Parse + validate (deterministic code)                   │
                                     │                          │                          │
                          reply: voice if you spoke,     valid suggestions → Postgres      │
                                 text if you typed          → card [✅ Approve][❌ Decline] │
                                                                                           ▼
                         Claim decision (one atomic SQL update: pending → approved/declined)
                                     │ approved                    │ otherwise
                                     ▼                             ▼
                     Create calendar event from the STORED payload   update card (declined /
                     → mark executed/failed → update card            expired / already handled)
```

### Why "it can't act on its own" actually holds

- **The AI has no write tools.** Its only tools are calendar listing, Gmail search and reading one email. Telling it not to act would be a polite request. Here, it has no means to act at all.
- **Suggestions are data, not actions.** The agent returns JSON. A plain code step validates each suggestion: supported type only, timezone-explicit dates, not in the past, at most 12 h long, at most 3 per turn. It stores the exact payload, and the card shows that same stored data.
- **Your tap runs plain workflow steps, without the AI.** A single SQL statement moves the suggestion out of `pending`, so a double-tap (or two taps racing) can't create it twice. Expired cards (default 12 h) are refused. The event is built from the stored payload, and the AI is never asked again.
- **Created events invite nobody.** The payload has no attendees and `sendUpdates` is `none`, so approving can't email third parties.
- **Only you get in.** The trigger filters on your chat ID, and the first code step checks it again: private chat, sender = you. If `TELEGRAM_CHAT_ID` is missing, it fails closed.
- **Every decision is logged** in `assistant.decision_log`.

## Changes from the original plan, and why

| Original assumption | Reality (verified Nov 2026) | What this project does |
|---|---|---|
| Telegram node `sendVoice` | n8n's Telegram node has no sendVoice | HTTP Request → Bot API, multipart upload |
| Code node makes .ogg/.mp3 | Gemini TTS returns raw PCM (s16le, 24 kHz) | Code node adds a WAV header. ffmpeg converts to OGG/Opus |
| `apk add ffmpeg` | n8n 2.x images have no package manager | Multi-stage Dockerfile with static ffmpeg (amd64 + arm64) |
| Execute Command available | Disabled by default since n8n 2.0 | `NODES_EXCLUDE` re-enables only that node |
| OAuth app in "Testing" | Refresh tokens expire after 7 days | Publish the consent screen to *In production* |
| Telegram Trigger chat filter | Versions < 1.4 drop button taps when the filter is set | Trigger pinned at v1.5 |

## 1. Prerequisites

- Docker + Compose v2
- **A public HTTPS URL for n8n.** Telegram has to reach the assistant. Use the Oracle VM with a domain (§9), or a tunnel such as Cloudflare Tunnel on your PC. The morning briefing alone works without one.
- Gemini API key ([aistudio.google.com](https://aistudio.google.com))
- Telegram bot token (@BotFather) and your chat ID (@userinfobot). **Send `/start` to your bot once.**
- A Google Cloud project with the **Gmail API** and **Google Calendar API** enabled

## 2. Configure

```bash
cp .env.example .env
openssl rand -hex 32   # → N8N_ENCRYPTION_KEY (back it up off this machine)
openssl rand -hex 32   # → POSTGRES_PASSWORD
# fill TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, and the URL settings
```

## 3. Start

```bash
docker compose --profile cloud up -d --build    # VM with Caddy + HTTPS
# or: docker compose up -d --build              # local (briefing only, unless tunneled)

docker compose exec n8n /usr/local/bin/ffmpeg -hide_banner -encoders | grep opus   # expect libopus
```

On first start, Postgres creates the `assistant` schema automatically. **If your Postgres volume already existed** (from the briefing-only version), apply it once:

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < docker/postgres/init/01-assistant.sql
```

Open the editor and create the owner account.

## 4. Google OAuth client

1. OAuth consent screen: *External*. Add yourself as a test user.
2. OAuth client ID → *Web application*. Redirect URI: `${WEBHOOK_URL}rest/oauth2-credential/callback`
3. **Publish the app (Audience → Publish app).** Otherwise everything stops after 7 days with `invalid_grant`.

Approving suggestions needs **calendar write** scope. n8n's Google Calendar credential requests it by default, but your Google consent screen must allow it.

## 5. Credentials in n8n (6 total)

| Credential type | Used by | Fields |
|---|---|---|
| **Google Calendar OAuth2 API** | briefing, Jarvis tool, Create calendar event | Client ID + Secret → *Sign in* |
| **Gmail OAuth2 API** | briefing, Jarvis search/read tools | Client ID + Secret → *Sign in* |
| **Header Auth** ("Gemini API key") | Gemini HTTP nodes (TTS, script, transcription) | Name `x-goog-api-key`, Value = your key |
| **Google Gemini (PaLM) API** | Jarvis chat model | Host `https://generativelanguage.googleapis.com`, API key |
| **Postgres** | chat memory + proposals | Host `postgres`, DB/user/password from `.env`, port 5432, SSL off |
| **Telegram API** | Telegram Trigger only | Bot token |

(The Telegram token is also read from `.env` by the HTTP nodes. The trigger needs its own credential to register the webhook.)

## 6. Import

```bash
docker compose exec n8n n8n import:workflow --separate --input=/workflows
```

The workflows keep fixed IDs, so the briefing and Jarvis find *Speak* automatically. In each workflow, open the nodes with a credential warning and attach the credential.

## 7. Test, then publish

1. **Speak**: publish it first (the other two call its published version).
2. **Morning Briefing**: *Execute workflow*. A voice note should arrive in about 20 s.
3. **Assistant**: publish it (this registers the Telegram webhook). Then try:
   - text: *"What's on my calendar tomorrow?"*
   - voice: *"Did Sara email me this week?"*
   - *"Put a dentist appointment on Thursday at 3pm for an hour"* → a card appears → tap **Approve** → check your calendar.
   - Tap **Approve** again → *"Already executed"*.

Telegram allows one webhook per bot. If you use *Listen for test event* in the editor, publish again afterwards to restore the production webhook.

## 8. Knobs

| Where | Field | Default |
|---|---|---|
| Speak → Config | `ttsModel`, `voiceName`, `ttsStyle` | `gemini-3.1-flash-tts-preview`, `Kore` |
| Briefing → Config | `textModel`, `language`, `maxChars` | `gemini-flash-lite-latest`, English, 300 |
| Assistant → Config | `transcribeModel`, `proposalTtlHours` | `gemini-flash-lite-latest`, 12 |
| Assistant → Gemini chat model | `modelName` | `models/gemini-flash-latest` |
| Assistant → Chat memory | `contextWindowLength` | 12 messages |
| Assistant → Jarvis | system message (persona, rules, output format) | |

## 9. Oracle Cloud notes

- Google rejects raw IPs as redirect URIs: point a domain at the VM (a free DuckDNS subdomain works). Set `N8N_HOST`, `N8N_PROTOCOL=https`, `WEBHOOK_URL=https://your.domain/`.
- Open 80/443 in **both** the VCN security list and the VM firewall.
- Port 5678 is bound to `127.0.0.1`. Only Caddy is public.

## 10. Privacy and cost

- **Free-tier Gemini traffic may be used by Google to improve its products.** Jarvis sends your messages, voice notes, and whatever email/calendar content it looks up. Enabling billing turns that off. Personal use costs very little.
- The TTS model is preview-only with small free quotas. If it's rate-limited, *Speak* falls back to a text message.

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| Bot never answers | Assistant not published, `WEBHOOK_URL` not public HTTPS, or test webhook still registered (republish) |
| Answers but buttons do nothing | Trigger must include `callback_query` (it does) at v1.4+. Check the execution list for the tap |
| `invalid_grant` after a week | Consent screen still in *Testing*. Publish it and reconnect the Google credentials |
| `relation "assistant.proposals" does not exist` | Apply the schema SQL (§3) |
| `Unrecognized node type: executeCommand` | `docker compose up -d --force-recreate n8n` |
| `access to env vars denied` | `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` must be set. Recreate the container |
| `The file ... is not writable` | `docker compose exec -u root n8n chown -R node:node /home/node/.n8n-files` |
| Jarvis replies with raw JSON or no cards | The model ignored the format. *Parse + validate* still answers. Try a stronger `modelName` |
| "I dropped N suggestions…" | The validator rejected malformed dates or types. See `rejectedProposals` in the execution |

## Development

```
src/*.js, src/assistant/*.js     Code node sources (edit here)
src/assistant/sql/*.sql          queries used by the Postgres nodes
src/build_workflows.py           regenerates workflows/*.json from src/
docker/postgres/init/            assistant schema
tests/                           npm test → 32 code-node tests + 13 SQL tests (embedded Postgres)
scripts/                         summary scripts for agents + audit-invariants.py (13 checks)
.claude/agents/, plan/           the Claude Code agent team and the phased plan
```

```bash
python3 src/build_workflows.py
cd tests && npm install && npm test
```
