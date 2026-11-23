# P1: Preflight
owner: infra-deployer · verify: self · previous handoff: none

## Goal
Confirm the machine can run the stack and `.env` is complete, without ever exposing a secret.

## Read only
`.env.example`, `scripts/check-env.sh`, `scripts/gen-secrets.sh`

## Steps
1. `docker --version && docker compose version`. Need Compose v2.
2. If `.env` doesn't exist: `cp .env.example .env`.
3. `./scripts/check-env.sh`
4. If only `N8N_ENCRYPTION_KEY` / `POSTGRES_PASSWORD` are PLACEHOLDER: run `./scripts/gen-secrets.sh` (it asks for permission), then re-run check-env.
5. Telegram keys or URL keys still MISSING/PLACEHOLDER → NEEDS_HUMAN with the exact key names and where to get them (README §1).
6. Report the MODE line (`local` or `cloud`) that check-env prints. P2 needs it.

## Acceptance criteria
- [ ] Docker and Compose v2 present
- [ ] `./scripts/check-env.sh` exits 0
- [ ] MODE reported

## Escalate if
Docker is missing, or the user must fill values. Remind them in NEEDS_HUMAN to **back up N8N_ENCRYPTION_KEY** off this machine.
