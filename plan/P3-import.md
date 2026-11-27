# P3: Import workflows
owner: n8n-operator · verify: self · previous handoff: plan/handoffs/P2.md

## Goal
Load the three workflows into n8n with their fixed IDs.

## Read only
`scripts/stack-health.sh` (if n8n looks down)

## Steps
1. `docker compose exec -T n8n n8n import:workflow --separate --input=/workflows 2>&1 | tail -n 10`
2. `docker compose exec -T n8n n8n list:workflow 2>&1 | tail -n 10`
3. "Owner not set up" errors → NEEDS_HUMAN: open the editor URL and create the owner account first, then rerun this phase.

## Acceptance criteria
- [ ] `list:workflow` shows `mbSpeakVoiceNote`, `mbMorningBrief01`, `mbAssistant00001`, `mbUniMailIngest1`
- [ ] No import errors

## Note for the handoff
NEXT is always the human credentials checkpoint H1. Put the editor URL (from `WEBHOOK_URL`, printed by `./scripts/check-env.sh`) in NEEDS_HUMAN.
