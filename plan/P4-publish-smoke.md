# P4: Publish and smoke test
owner: n8n-operator · verify: qa-reviewer · previous handoff: plan/handoffs/P3.md

## Goal
Publish all three workflows, restart n8n, prove the briefing works end to end and the Telegram webhook is registered.

## Read only
`scripts/run-briefing.sh`, `scripts/tg-webhook-info.sh`, `scripts/stack-health.sh`

## Steps
1. Publish in order (each `| tail -n 5`):
   `docker compose exec -T n8n n8n publish:workflow --id=mbSpeakVoiceNote`
   `docker compose exec -T n8n n8n publish:workflow --id=mbMorningBrief01`
   `docker compose exec -T n8n n8n publish:workflow --id=mbAssistant00001`
   `docker compose exec -T n8n n8n publish:workflow --id=mbUniMailIngest1` (needs `assistant.uni_emails`: re-apply `docker/postgres/init/01-assistant.sql` on an existing volume)
2. `docker compose restart n8n`, then `./scripts/stack-health.sh`.
3. `./scripts/run-briefing.sh`. Runs the briefing once and prints only the verdict. A voice note should arrive on the user's phone.
4. `./scripts/tg-webhook-info.sh`
5. Credential errors in step 3 ("credentials not found/invalid") → RESULT blocked, NEEDS_HUMAN naming the node. Don't retry.

## Acceptance criteria
- [ ] 4 publish commands succeeded
- [ ] `run-briefing: PASS`
- [ ] `webhook url: set` and it starts with the public `WEBHOOK_URL` host
- [ ] `webhook last_error: none` (or older than the restart)
- [ ] NEEDS_HUMAN asks the user to confirm the voice note arrived

## Local mode note
Without a public HTTPS URL the webhook can't register: mark the webhook criteria `skipped (local mode)`. The briefing still counts.
