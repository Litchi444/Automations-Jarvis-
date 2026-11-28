# Jarvis on n8n: Telegram voice assistant + morning briefing

A self-hosted personal assistant you talk to on Telegram, by voice or text. It reads your Google Calendar, school timetable, to-do list (Google Tasks) and Gmail. **It can suggest things but never act on its own:** every suggestion arrives as a card with **Approve / Decline** buttons, and only your tap creates, moves or deletes anything. The one exception you chose: when *you* ask it to add a task or mark one done, it does it right away and sends **↩️ Undo**.

Every day at 07:30 it also sends a short spoken briefing of your day: when your first class starts and where, breaks, lunch, when classes start again and finish, tasks due today, then email.

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

## The four workflows

| Workflow | Trigger | Role |
|---|---|---|
| **Speak** (`workflow_speak.json`) | called by the briefing and Jarvis | text → Gemini TTS → ffmpeg OGG/Opus → Telegram voice note (text fallback if it fails) |
| **Morning Briefing** | daily 07:30 | school day (from the timetable ICS link, worked out in code) + today's events + open tasks + important unread Gmail + last 24 h of university mail → Gemini script → *Speak* |
| **Assistant (Jarvis)** | Telegram messages + button taps | conversation, read-only tools, approval cards, instant to-do actions with Undo |
| **University mail → database** (`workflow_university_mail.json`) | new mail in the university IMAP inbox | copies each email into `assistant.uni_emails` (180-day retention). Never marks, moves or deletes mail. Jarvis searches the copy with fixed read-only SQL |

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
- **To-do exception, decided by code, not the AI.** A task add or "done" runs without a card only when *your* message (typed, or the voice transcript) contains to-do words ("TDL", "to-do", "tâche", "fini", "done"...). The agent cannot open that gate, so an email that tells it to add a task still produces a card. The action is logged first, runs from the stored row, and the confirmation carries **↩️ Undo** for 24 h (one atomic claim, like approvals).
- **Deletes and moves always need a tap, and are re-checked.** Before deleting a task, or moving/deleting an event, the workflow fetches it by its stored id and refuses if its title or time no longer match the card. Only the primary calendar is written, so a school class can never be moved or deleted.
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
- **A public HTTPS URL for n8n.** Telegram has to reach the assistant. Options (§9): a small VPS with a domain (about 5 €/month, Hetzner for example), or a Cloudflare Tunnel on your PC while you test. The morning briefing alone works without one.
- Gemini API key ([aistudio.google.com](https://aistudio.google.com))
- Telegram bot token (@BotFather) and your chat ID (@userinfobot). **Send `/start` to your bot once.**
- A Google Cloud project with the **Gmail API**, **Google Calendar API** and **Google Tasks API** enabled

## 2. Configure

```bash
cp .env.example .env
openssl rand -hex 32   # → N8N_ENCRYPTION_KEY (back it up off this machine)
openssl rand -hex 32   # → POSTGRES_PASSWORD
# fill TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, and the URL settings
```

## 3. Start

```bash
docker compose --profile cloud up -d --build    # VPS with Caddy + HTTPS (see §9 for a one-shot bootstrap)
# or: docker compose up -d --build              # local (briefing only, unless tunneled)

docker compose exec n8n /usr/local/bin/ffmpeg -hide_banner -encoders | grep opus   # expect libopus
```

On first start, Postgres creates the `assistant` schema automatically. **If your Postgres volume already existed** (from the briefing-only version), apply it once:

```bash
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/01-assistant.sql'
```

**Writing skills.** When you ask Jarvis to write something (an email, a cover letter...), it looks up a matching guide in `skills/*.md` and follows it. Each file is `skills/<name>.md` with a `description:` line in a `---` front matter, then the guide. After adding or editing one, run `python3 src/build_workflows.py` (regenerates `docker/postgres/init/02-skills.sql`), deploy, and load it (idempotent, also removes deleted skills):

```bash
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/02-skills.sql'
```

**Answer styles.** A style changes how Jarvis talks to you (tone, length, personality) on every reply and in the morning briefing, not just drafts. In the briefing it shapes tone and wording only: the length limit and spoken-text rules still apply. Styles live in `styles/<name>.md`, same format as skills (body up to 2000 characters, since it is added to every prompt; `off` is reserved). In Telegram: `/style` lists them and shows the current one, `/style butler` picks one, `/style off` goes back to the default. The command is handled by a plain workflow node; the agent can read the active style but never change it, and the style never overrides the safety or output rules, nor drafts written with a skill. After adding or editing a style, rebuild (regenerates `docker/postgres/init/03-styles.sql`), deploy, and load it (idempotent; deleting a style resets chats that used it to the default). On an existing volume, re-apply `01-assistant.sql` once first to create the `styles` and `chat_settings` tables:

```bash
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/03-styles.sql'
```

Open the editor and create the owner account.

## 4. Google OAuth client

1. OAuth consent screen: *External*. Add yourself as a test user.
2. OAuth client ID → *Web application*. Redirect URI: `${WEBHOOK_URL}rest/oauth2-credential/callback`
3. **Publish the app (Audience → Publish app).** Otherwise everything stops after 7 days with `invalid_grant`.

Approving suggestions needs **calendar write** scope. n8n's Google Calendar credential requests it by default, but your Google consent screen must allow it.

## 5. Credentials in n8n (8 total)

| Credential type | Used by | Fields |
|---|---|---|
| **Google Calendar OAuth2 API** | briefing, Jarvis tools (calendar + school), create / move / delete event | Client ID + Secret → *Sign in* |
| **Google Tasks OAuth2 API** | briefing (*Get open tasks*), Jarvis *Tasks: list*, every task node | Client ID + Secret → *Sign in* |
| **Gmail OAuth2 API** | briefing, Jarvis search/read tools | Client ID + Secret → *Sign in* |
| **Header Auth** ("Gemini API key") | Gemini HTTP nodes (TTS, script, transcription) | Name `x-goog-api-key`, Value = your key |
| **Google Gemini (PaLM) API** | Jarvis chat model | Host `https://generativelanguage.googleapis.com`, API key |
| **Postgres** | chat memory, proposals, university mail copy (+ Jarvis *Uni mail* tools, briefing) | Host `postgres`, DB/user/password from `.env`, port 5432, SSL off |
| **Telegram API** | Telegram Trigger only | Bot token |
| **IMAP** ("University mail") | University mail → database | User = university login, Password = university password, Host `imap.univ-lemans.fr`, Port `993`, SSL/TLS on. If the connection fails on the certificate (the server presents `jaguar-r1.univ-lemans.fr`), enable *Allow Self-Signed Certificates* |

(The Telegram token is also read from `.env` by the HTTP nodes. The trigger needs its own credential to register the webhook.)

### 5b. School timetable and to-do list

1. **Find the timetable link.** On your school's timetable site (ADE, Celcat...), use *Export* / *Subscribe* / *iCal* and copy the link (often ends in `.ics`, may start with `webcal://`). Keep it private.
2. **Put it in Google Calendar:** Google Calendar → *Other calendars* → **+** → *From URL* → paste. It shows up as its own calendar on your phone. Google refreshes it every few hours, which is fine for browsing.
3. **Tell Jarvis:** in `.env` set `SCHOOL_ICS_URL` (the link) and `SCHOOL_CALENDAR_ID` (Google Calendar → settings of that calendar → *Calendar ID*). Then `docker compose up -d` so n8n sees them. The briefing downloads the link itself every morning, so a room change made the same day is not missed. Both are optional: without them the briefing says there is no timetable.
4. **To-do list:** nothing to set up beyond the *Google Tasks* credential. Jarvis uses your default list (*My Tasks*), visible in the Google Tasks app and next to Google Calendar.

Existing database? Re-apply `01-assistant.sql` (command in §3): it widens the proposal kinds and adds the Undo status.

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

4. **University mail → database**: apply the schema first (it adds `assistant.uni_emails`; command under *Development*/CLAUDE.md), then publish. It starts with mail received since the activation day. Send yourself a test email at the university address, then ask Jarvis *"Any new emails from the fac?"*.

Telegram allows one webhook per bot. If you use *Listen for test event* in the editor, publish again afterwards to restore the production webhook.

## 8. Knobs

| Where | Field | Default |
|---|---|---|
| Speak → Config | `ttsModel`, `voiceName`, `ttsStyle` | `gemini-3.1-flash-tts-preview`, `Enceladus` (male, low; e.g. `Kore` for a female voice) |
| Briefing → Config | `textModel`, `language`, `maxChars` | `gemini-flash-lite-latest`, English, 700 |
| `school_day.js` | `MIN_BREAK_MIN`, `LUNCH` window | 10 min, 11:30–14:00 |
| Assistant → Config | `transcribeModel`, `proposalTtlHours` | `gemini-flash-lite-latest`, 12 |
| Assistant → Gemini chat model | `modelName` | `models/gemini-flash-lite-latest` (on the free tier, `gemini-flash-latest` often fails with 503 "high demand" or the 5 requests/minute cap) |
| Assistant → Chat memory | `contextWindowLength` | 12 messages |
| Assistant → Jarvis | system message (persona, rules, output format) | |

## 9. Hosting

Pick one. The stack is the same everywhere; only the URL differs.

| Option | Cost | Telegram assistant | Good for |
|---|---|---|---|
| VPS + domain + Caddy | about 5 €/month | always on | production |
| PC + Cloudflare Tunnel | free | only while the PC is on | testing before you pay for a server |
| PC, no tunnel | free | no | morning briefing only |

### 9a. VPS (Hetzner or any Debian/Ubuntu box)

Sizing: 2 vCPU and 4 GB RAM is enough (Postgres + n8n + ffmpeg). With 2 GB, keep the swap file the script creates and expect slow builds. The n8n image ships static ffmpeg for amd64 and arm64, so Hetzner's ARM plans work too. Hetzner bills by the hour with no commitment: create the server when you are ready, delete it to stop paying. Check the current plan and price on hetzner.com before ordering, they have changed several times in 2026.

1. Create the server (Debian 12/13 or Ubuntu 24.04, add your SSH key).
2. Get a hostname. Google rejects raw IPs as redirect URIs. A free DuckDNS subdomain works. Point its A record at the server IP.
3. On the server:
   ```bash
   apt-get update && apt-get install -y git
   git clone <your repo url> && cd Automations-Jarvis-
   scripts/bootstrap-vps.sh --domain jarvis.example.com   # add --dry-run first if you want to read the plan
   nano .env                                               # TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
   scripts/check-env.sh
   docker compose --profile cloud up -d --build
   scripts/stack-health.sh
   ```
   The script updates the system, installs Docker, adds swap, opens only 22/80/443 in ufw, writes `N8N_HOST`, `N8N_PROTOCOL`, `WEBHOOK_URL` and generates `N8N_ENCRYPTION_KEY` and `POSTGRES_PASSWORD`. It never prints secrets and never overwrites them when data volumes already exist. Re-running it is safe.
4. Back up `N8N_ENCRYPTION_KEY` somewhere other than the server. Without it, every stored credential is lost if the server dies.
5. Port 5678 stays bound to `127.0.0.1` and Postgres has no published port. Only Caddy is public.

Hetzner also has a cloud firewall in its console. The script's ufw rules are enough, but you can add the same three ports there.

### 9d. Backups

A 5 € VPS has no safety net. `scripts/backup.sh` saves the two things git cannot rebuild: the Postgres database (workflows, encrypted credentials, the `assistant` schema, chat memory) and `.env` (it holds `N8N_ENCRYPTION_KEY`, without which the stored credentials are unreadable). Both go into one tar, encrypted with [age](https://github.com/FiloSottile/age) to a **public** key. The server never holds the private key, so a stolen server or backup reveals nothing.

1. On **your own machine**: `age-keygen -o jarvis-backup.key`. Store that file in your password manager and on paper. Lose it and the backups are worthless.
2. On the server, put the `Public key: age1...` line in `.env` as `BACKUP_AGE_RECIPIENT`. Other settings are in `.env.example`.
3. Run once by hand: `scripts/backup.sh`. Then schedule it: `sudo scripts/install-backup-timer.sh` (daily 03:15 server time, catches up after a reboot).
4. Off-server copy: configure an rclone remote (`rclone config`; Backblaze B2, SFTP and others work) and set `BACKUP_RCLONE_REMOTE=b2:your-bucket/jarvis`. Check the provider's current free tier and prices yourself. Without it, backups die with the server.
5. On failure the script sends you a Telegram message. A backup that silently stops is the usual way these setups fail, so keep the bot chat unmuted.

**Verify, do not trust.** From a machine that has the private key and the archive:

```bash
scripts/restore.sh --identity jarvis-backup.key --latest        # restores into a throwaway database, counts workflows, drops it
```

Live data is untouched. Do this after the first backup and every few months.

**Disaster recovery on a fresh server:**

```bash
scripts/bootstrap-vps.sh --domain your.domain
rclone copy b2:your-bucket/jarvis/jarvis-XXXX.tar.age .       # or scp
docker compose up -d postgres
scripts/restore.sh --identity jarvis-backup.key jarvis-XXXX.tar.age --apply
docker compose --profile cloud up -d --build
```

`--apply` asks you to type `restore`, replaces the live database, writes the backed-up `.env` to `.env.restored` (never overwrites yours), and adopts the backed-up `N8N_ENCRYPTION_KEY` only when no n8n data volume exists yet. Afterwards republish the assistant workflow so Telegram's webhook is registered again.

Not backed up on purpose: the Caddy certificates (reissued automatically) and `n8n_files` (temporary audio). Hetzner also sells whole-server snapshots as an extra; check the current price on their site if you want a second layer.

### 9b. PC + Cloudflare Tunnel (free, for testing)

```bash
docker compose up -d --build                         # no cloud profile, no Caddy
cloudflared tunnel --url http://localhost:5678       # prints https://<random>.trycloudflare.com
```

Then in `.env`: `N8N_HOST=<random>.trycloudflare.com`, `N8N_PROTOCOL=https`, `WEBHOOK_URL=https://<random>.trycloudflare.com/`, and `docker compose up -d --force-recreate n8n`. Republish the assistant workflow so Telegram's webhook is registered on the new URL.

Limits of a quick tunnel: the hostname changes at every restart, so repeat the steps above each time, and the Google OAuth redirect URI (built from `WEBHOOK_URL`) changes with it. A named tunnel on a domain you own gives a stable hostname.

### 9c. PC only

Leave `.env` on `localhost` / `http`. The 07:30 briefing runs; the Telegram assistant does not receive messages.

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
| Jarvis replies with raw JSON or no cards | The model ignored the format. *Parse + validate* still answers. Try a stronger `modelName` (e.g. `models/gemini-3-flash-preview`) |
| Jarvis never answers; execution failed at *Gemini chat model* with 503 or 429 | Model overloaded or free-tier per-minute quota hit. Wait a minute, or switch `modelName` to a less busy model |
| "I dropped N suggestions…" | The validator rejected malformed dates or types. See `rejectedProposals` in the execution |

## Development

```
src/*.js, src/assistant/*.js     Code node sources (edit here)
src/assistant/sql/*.sql          queries used by the Postgres nodes
src/build_workflows.py           regenerates workflows/*.json from src/
docker/postgres/init/            assistant schema
tests/                           npm test → 32 code-node tests + 13 SQL tests (embedded Postgres)
scripts/                         summary scripts for agents, audit-invariants.py (13 checks), bootstrap-vps.sh
.claude/agents/, plan/           the Claude Code agent team and the phased plan
```

```bash
python3 src/build_workflows.py
cd tests && npm install && npm test
```
