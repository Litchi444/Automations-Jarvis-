# CLAUDE.md: Jarvis on n8n

Self-hosted n8n 2.x stack: Telegram voice/text assistant ("Jarvis") with human-approved suggestions, plus a daily voice briefing. README.md has the full design.

## Non-negotiable design rule
**The AI never gets write access.** Agent tools stay read-only. Anything that changes the outside world goes: agent JSON proposal → `parse_agent_output.js` validation → `assistant.proposals` row → Telegram card → user tap → `claim_decision.sql` (atomic) → plain workflow node using the STORED payload. Don't add write tools to the agent, don't let the agent re-generate a payload after approval, and don't add attendees or email-sending without the user asking explicitly.

## Ground truth (verified against n8n 2.48 source, don't "fix" back)
- n8n Telegram node has no sendVoice → HTTP Request to the Bot API.
- Telegram Trigger must be ≥ v1.4 when `chatIds` is set, or button taps (callback_query) are dropped.
- Gemini TTS returns raw PCM s16le/24 kHz mono → `pcm_to_wav.js` → ffmpeg → OGG/Opus.
- n8n 2.x image: no apk/apt, maybe no shell for RUN → Dockerfile uses COPY only.
- n8n 2.x defaults: Execute Command excluded (`NODES_EXCLUDE`), file nodes confined to `/home/node/.n8n-files`, `$env` blocked unless `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`.
- Postgres node ≥ 2.5: `queryReplacement` given as one array expression → each element is a bind value (objects JSON-stringified). Keep SQL parameterized. Never interpolate.
- Newer Gemini text models reject `temperature`/`top_p`/`top_k`.

## Rules
- Edit `src/**/*.js` and `src/assistant/sql/*.sql`, then `python3 src/build_workflows.py`. Never hand-edit jsCode/query strings in the JSON.
- Node names are referenced via `$('Name')`. If you rename a node, update every reference (the tests mock them by name).
- Workflow IDs are fixed (`mbSpeakVoiceNote`, `mbMorningBrief01`, `mbAssistant00001`, `mbUniMailIngest1`) because workflows call each other by ID.
- University mail: IMAP trigger must keep `postProcessAction: "nothing"` (never mark/move mail). Agent reads the Postgres copy only via fixed SELECT `postgresTool` queries (audited).
- Secrets only in `.env` or n8n credentials.
- After changes: `cd tests && npm test` must pass.

## Commands
```bash
python3 src/build_workflows.py
cd tests && npm install && npm test
docker compose --profile cloud up -d --build
docker compose exec n8n n8n import:workflow --separate --input=/workflows
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/01-assistant.sql'
docker compose logs -f n8n
```

## Agent team
Deployment and changes run through `claude --agent manager` (see `.claude/agents/` and `plan/`).
- Every subagent returns only the HANDOFF block defined in `plan/00-overview.md` (≤ 25 lines).
- Never read `.env` or print tokens. Use `scripts/check-env.sh` and the other summary scripts.
- Never open `workflows/*.json`. Use `src/` and `python3 scripts/audit-invariants.py`.
- Never run `n8n execute` raw (base64 audio floods context). Use `scripts/run-briefing.sh`.
- `python3 scripts/audit-invariants.py` must stay all PASS after any change.
