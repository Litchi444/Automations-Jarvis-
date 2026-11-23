# P2: Stack up
owner: infra-deployer · verify: qa-reviewer · previous handoff: plan/handoffs/P1.md

## Goal
Build the n8n+ffmpeg image, start the stack, confirm ffmpeg has Opus and the `assistant` schema exists.

## Read only
`docker-compose.yml`, `docker/n8n/Dockerfile`, `docker/postgres/init/01-assistant.sql`, `scripts/stack-health.sh`

## Steps
1. Use MODE from the P1 handoff:
   - cloud: `docker compose --profile cloud up -d --build 2>&1 | tail -n 25`
   - local: `docker compose up -d --build 2>&1 | tail -n 25`
2. `./scripts/stack-health.sh`. It waits up to ~90 s for health.
3. If it reports `schema: MISSING` (the Postgres volume existed before), apply the schema:
   `docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < docker/postgres/init/01-assistant.sql`
   Then re-run stack-health.
4. Image build failing on a registry pull → ISSUES with the failing image name (often `mwader/static-ffmpeg` or `docker.n8n.io/n8nio/n8n` tag). Don't change versions without asking.

## Acceptance criteria
- [ ] `postgres` healthy, `n8n` running
- [ ] `n8n healthz: PASS`
- [ ] `ffmpeg libopus: PASS`
- [ ] `schema assistant.proposals: PASS`
- [ ] cloud mode only: `caddy` running

## qa-reviewer additionally checks
- [ ] `(cd tests && npm install --silent && npm test 2>&1 | tail -n 15)` passes
- [ ] `python3 scripts/audit-invariants.py` → all PASS
