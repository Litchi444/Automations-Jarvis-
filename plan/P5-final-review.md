# P5: Final review
owner: qa-reviewer · verify: final · previous handoffs: plan/handoffs/P2.md, P4.md, H2.md

## Goal
An independent GO/NO-GO on the deployed system.

## Read only
`CLAUDE.md`, `plan/STATUS.md`, the three handoffs above, `scripts/audit-invariants.py`

## Checks
1. `python3 scripts/audit-invariants.py`: every line PASS
2. `(cd tests && npm test 2>&1 | tail -n 15)`: all pass
3. `./scripts/stack-health.sh`: all PASS
4. `./scripts/tg-webhook-info.sh`: webhook set, no recent error (skip in local mode)
5. `./scripts/decision-log.sh`: no `approved` rows stuck older than 10 min (an approval that never executed)
6. `.claude/settings.json` still denies reading `.env`, and no workflow JSON contains a secret (audit check `no secrets`)
7. STATUS.md has no `blocked` or `fail` rows except skipped-by-user

## Verdict
- **GO**: all checks pass, or only skips the user chose.
- **NO-GO**: list each blocking item with the evidence line, max 6.
