# Plan overview: deploy Jarvis with an agent team

**Run:** `claude --agent manager` from the project root. The manager reads `STATUS.md` and runs one phase at a time.

## Phases
| ID | Owner | Goal | Verified by |
|---|---|---|---|
| P1 | infra-deployer | Preflight: tools present, `.env` complete | (self) |
| P2 | infra-deployer | Stack up: build, start, ffmpeg+Opus, schema | qa-reviewer |
| P3 | n8n-operator | Import the 3 workflows | (self) |
| H1 | human | OAuth app + 6 credentials attached in the n8n UI | (human) |
| P4 | n8n-operator | Publish, restart, briefing smoke test, webhook | qa-reviewer |
| H2 | human + n8n-operator | Live assistant test from your phone | n8n-operator |
| P5 | qa-reviewer | Final review: tests, invariants, GO/NO-GO | (final) |

Later features → `CR-template.md` (change requests), same loop.

## Context budget (why the plan is split like this)
- **One phase = one fresh subagent.** Nothing piles up across phases. Only the ≤25-line handoff carries forward.
- **The manager never reads raw output.** It sees phase files, STATUS and handoffs only.
- **Phase files are short** (≤ 60 lines) and list exactly which files to read.
- **Scripts do the summarizing.** `scripts/*` turn logs and APIs into a few PASS/FAIL lines. Agents cap any other output with `tail`/`cut`.
- **Big generated files are off-limits.** `workflows/*.json` (~58 KB total) are generated. Agents work from `src/`, and `audit-invariants.py` checks the JSON.
- **`maxTurns` caps** each agent (30–50 turns). It returns partial work instead of drifting.
- **Secrets never enter any context.** `.env` is denied to Read/Edit. Scripts report keys without values.

## HANDOFF block (every subagent returns exactly this, ≤ 25 lines)
```
HANDOFF <phase-id> | RESULT: pass | fail | blocked   (P5: GO | NO-GO)
DONE:
- <what was done, one line each, max 6>
EVIDENCE:
- <decisive output line per acceptance criterion, max 6>
ISSUES:
- <problem + suspected cause, or "none">
NEEDS_HUMAN: <exact action for the user, or "none">
NEXT: <one line>
```

## Status values (STATUS.md)
`todo` → `in_progress` → `done` | `fail` (retryable once) | `blocked` (needs the user) | `skipped`
