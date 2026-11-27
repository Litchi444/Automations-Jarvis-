# Plan 004: Move the Jarvis system prompt out of the generator into `src/`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 8f6b212..HEAD -- src/build_workflows.py CLAUDE.md`
> If either changed, compare the "Current state" excerpts against the live
> code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/002-audit-full-regeneration-sync.md (so the audit catches a prompt edit without rebuild)
- **Category**: tech-debt
- **Planned at**: commit `8f6b212`, 2026-11-27

## Why this matters

The repo rule is "edit `src/`, then run the generator": all Code-node JS
lives in `src/**/*.js` and all SQL in `src/assistant/sql/*.sql`. The single
most-edited piece of agent behavior — the Jarvis system prompt — is the
exception: a 28-line Python string constant `SYSTEM_MESSAGE` inside
`src/build_workflows.py`. Prompt tweaks therefore mean editing the generator,
diffs mix prompt wording with build logic, and the prompt can't be reviewed or
tested as a file. Moving it to `src/assistant/system_message.txt` makes the
prompt a first-class source with the same workflow as code and SQL. The
generated workflow JSON must not change.

## Current state

- `src/build_workflows.py:244-271` — the constant (excerpt):
  ```python
  SYSTEM_MESSAGE = """=You are Jarvis, the user's personal assistant, talking with them on Telegram.
  Current time: {{ $now.setZone($env.GENERIC_TIMEZONE || 'Europe/Paris').toFormat("cccc d LLLL yyyy, HH:mm ZZ") }} (timezone {{ $env.GENERIC_TIMEZONE || 'Europe/Paris' }}).

  CAPABILITIES
  ...
  Use "proposals": [] when there is nothing to suggest. At most 3 proposals."""
  ```
  Notes: it starts with `=` (n8n's "this is an expression" marker), contains
  `{{ ... }}` n8n expressions, single and double quotes, **no backslashes**,
  and has **no trailing newline** (string ends right after `proposals.`).
- `src/build_workflows.py:329` — the only use:
  `"options": {"systemMessage": SYSTEM_MESSAGE, "maxIterations": 8},`
- `src/build_workflows.py:34-35` — the loader used for code and SQL:
  ```python
  def read(rel: str) -> str:
      return (SRC / rel).read_text(encoding="utf-8")
  ```
  `read_text` with default newline handling turns CRLF into LF on Windows, so
  a CRLF checkout still yields LF text.
- Exemplar: `code(rel)` at `src/build_workflows.py:90-91` wraps `read()`.
- `CLAUDE.md` `## Rules`, first bullet:
  "Edit `src/**/*.js` and `src/assistant/sql/*.sql`, then `python3 src/build_workflows.py`. Never hand-edit jsCode/query strings in the JSON."

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `python3 src/build_workflows.py` (Windows: `py ...`) | exit 0, `expression lint OK` |
| No output change | `git status --short workflows/` | empty |
| Audit | `python3 scripts/audit-invariants.py` | all PASS |
| Tests | `cd tests && npm test` | exit 0 |

Never open `workflows/*.json` directly.

## Scope

**In scope**:
- `src/assistant/system_message.txt` (create)
- `src/build_workflows.py` (remove constant, load file)
- `CLAUDE.md` (one rule line)

**Out of scope**:
- Any wording change to the prompt. Byte-identical move only.
- The small inline prompts (transcription instruction at
  `src/build_workflows.py:315-317`, `ttsStyle` at `:127`, briefing prompt in
  `src/build_prompt.js`). Leave them.
- `README.md` — only touch if it literally says the prompt lives in `build_workflows.py`
  (`grep -n SYSTEM_MESSAGE README.md`); otherwise leave it.

## Git workflow

- Branch: `advisor/004-system-prompt-to-src`
- One commit, e.g. `Move Jarvis system prompt into src/assistant/system_message.txt`.
- Do NOT push.

## Steps

### Step 1: Extract the prompt byte-for-byte

Do not copy by hand. Run from repo root:
```bash
py -c "import sys; sys.path.insert(0,'src'); import build_workflows as b; s=b.SYSTEM_MESSAGE; assert s.startswith('='); open('src/assistant/system_message.txt','w',encoding='utf-8',newline='\n').write(s[1:] + '\n')"
```
The file holds the prompt **without** the leading `=` and **with** one trailing newline.

**Verify**: `head -c 40 src/assistant/system_message.txt` → `You are Jarvis, the user's personal assi`
and `tail -c 20 src/assistant/system_message.txt` ends with `At most 3 proposals.` + newline.

### Step 2: Load it in the generator

- Delete the `SYSTEM_MESSAGE = """...` constant (lines 244-271).
- Change line 329 to:
  ```python
  "options": {"systemMessage": "=" + read("assistant/system_message.txt").rstrip("\n"), "maxIterations": 8},
  ```

**Verify**: `py src/build_workflows.py` → exit 0; `git status --short workflows/` → **empty**
(proves byte-identical output); `grep -n SYSTEM_MESSAGE src/build_workflows.py` → no matches.

### Step 3: Update the rule in CLAUDE.md

Change the first `## Rules` bullet to:
"Edit `src/**/*.js`, `src/assistant/sql/*.sql` and `src/assistant/system_message.txt` (agent system prompt, n8n expression syntax: `{{ }}` allowed), then `python3 src/build_workflows.py`. Never hand-edit jsCode/query/prompt strings in the JSON."

**Verify**: `grep -n system_message.txt CLAUDE.md` → 1 match.

## Test plan

Byte-identical generated JSON (Step 2 verify) is the test. Then:
`py scripts/audit-invariants.py` → all PASS; `cd tests && npm test` → exit 0.
If plan 002 has landed, also prove the sync check covers the new file: append
a space to the last line of `system_message.txt`, run the audit (expect check 9
FAIL on `workflow_assistant.json`), remove the space, audit → PASS.

## Done criteria

- [ ] `src/assistant/system_message.txt` exists, does not start with `=`
- [ ] `grep -n SYSTEM_MESSAGE src/build_workflows.py` → empty
- [ ] `py src/build_workflows.py` exits 0 and `git status --short workflows/` is empty
- [ ] `py scripts/audit-invariants.py` exits 0
- [ ] `cd tests && npm test` exits 0
- [ ] `git diff --name-only` ⊆ {`src/build_workflows.py`, `CLAUDE.md`, `plans/README.md`} + new file

## STOP conditions

- `git status workflows/` shows a diff after Step 2 — the move was not
  byte-identical (likely a newline or encoding issue). Do not commit the JSON.
- The prompt is referenced anywhere else (`grep -rn SYSTEM_MESSAGE .` beyond
  `src/build_workflows.py` and `plans/`).

## Maintenance notes

- The file is an n8n expression template, not plain text: `{{ }}` is
  evaluated. `lint_expressions()` in the generator still checks balance on
  the built JSON.
- If the transcription / TTS prompts grow, move them the same way.
