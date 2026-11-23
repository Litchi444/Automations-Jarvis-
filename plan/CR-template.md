# CR-<n>: <title>
status: draft · requested: <date> · owner: manager

## Request (user's words, one or two lines)

## Design-rule check (required)
Does this give the AI any way to change the outside world on its own?
- [ ] No: read-only tools, or text only
- [ ] Yes → redesign it as a **proposal kind**: agent JSON → validator → `assistant.proposals` → card → `claim_decision` → plain node using the stored payload

## Tasks (each fits ONE workflow-builder run: ≤ 3 files + tests)
| # | Task | Files | Tests to add | Acceptance |
|---|---|---|---|---|
| T1 | | | | |
| T2 | | | | |

Typical split for a new proposal kind (e.g. Google Tasks):
- T1 validator: `parse_agent_output.js` (+ tests): new `type`, its fields, limits, card summary
- T2 schema + SQL: `01-assistant.sql` CHECK constraint (+ an idempotent ALTER for existing DBs) (+ SQL test)
- T3 wiring: `build_workflows.py`: route `kind` after "Approved?" to the new plain node, its mark executed/failed (+ audit rule in `audit-invariants.py`)
- T4 prompt + docs: Jarvis system message OUTPUT section, README knobs

## After the build tasks
- qa-reviewer: verify all task acceptance criteria and run the audit
- infra-deployer: apply the schema change if any
- n8n-operator: re-import (`import:workflow --separate --input=/workflows`), re-publish the changed workflow(s), restart, then H2-style live test of the new kind
