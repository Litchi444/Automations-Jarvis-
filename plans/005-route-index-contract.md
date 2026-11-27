# Plan 005: Tie Switch output indices in Code nodes to the generator's wiring

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 8f6b212..HEAD -- src/build_workflows.py src/assistant/route_update.js src/assistant/parse_agent_output.js src/assistant/callback_outcome.js tests/code_nodes.test.js`
> If any changed, compare the "Current state" excerpts against the live code;
> on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S–M
- **Risk**: MED (touches the approval path's routing; a wrong index sends a tap to the wrong branch)
- **Depends on**: plans/001-validate-node-references.md (same `WF`/`code()` area of the generator)
- **Category**: tech-debt
- **Planned at**: commit `8f6b212`, 2026-11-27

## Why this matters

Three n8n Switch nodes in the Assistant workflow route on a number that a
Code node computes: `Route` (0 voice, 1 text, 2 button tap), `Voice or text?`
(0 voice, 1 text) and `Approved?` (0 create event, 1 update card only). The
numbers are written twice — as literals in the JS and as output indices in
the generator's `w.link(...)` calls — and nothing checks they agree. Swapping
an index on one side silently misroutes (e.g. a "decline" tap reaching
`Create calendar event` is blocked only by the SQL claim, not by routing).
After this plan, each mapping is declared once in the generator, the JS must
contain the identical constant, and the build fails if they diverge.

## Current state

- `src/assistant/route_update.js` — returns `route: 2` (line ~25, callbacks),
  `route: 1` (line ~50 long-voice note, line ~65 text), `route: 0` (line ~52, voice).
  Header comment line 6: `// Output \`route\`: 0 = voice, 1 = text, 2 = button tap (callback)`.
- `src/assistant/parse_agent_output.js:123`:
  `replyRoute: wantsText ? 1 : 0,                   // 0 = voice reply (default), 1 = text reply`
- `src/assistant/callback_outcome.js:4,10,18`:
  ```js
  // Output `route`: 0 = create the event, 1 = just update the card.
  let route = 1;
  ...
    route = 0;
  ```
- `src/build_workflows.py` wiring:
  - `:289-290` `w.node("Route", ... {"mode": "expression", "numberOutputs": 3, "output": "={{ $json.route }}"})`
  - `:389-390` `"Voice or text?"` with `"numberOutputs": 2`
  - `:419-420` `"Approved?"` with `"numberOutputs": 2`
  - `:454-458`:
    ```python
    w.link("Route", "Show typing", 0)
    w.link("Route", "Get voice file path", 0)
    w.link("Route", "Show typing", 1)
    w.link("Route", "Prepare agent input", 1)
    w.link("Route", "Claim decision", 2)
    ```
  - `:468-469` `w.link("Voice or text?", "Speak reply", 0)` / `("Send text reply", 1)`
  - `:472-474` `w.link("Approved?", "Create calendar event", 0)` / `("Answer button", 1)` / `("Update card", 1)`
  - `:90-91` `def code(rel): return {"jsCode": read(rel)}`
- `scripts/audit-invariants.py:78` relies on `Approved?` output **0** being the
  write gate (`gated = {t for s, i, t in edges(asst) if s == "Approved?" and i == 0}`).
  Keep `create = 0`.
- Tests assert the numbers: `tests/code_nodes.test.js:16,18,25,28` (`route === 0/1/2`),
  `:53-58,79` (`replyRoute`), `:88,93` (`.route === 0/1`). The numeric values do
  not change in this plan, so tests must pass unchanged.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Build | `python3 src/build_workflows.py` (Windows: `py ...`) | exit 0 |
| Audit | `python3 scripts/audit-invariants.py` | all PASS |
| Tests | `cd tests && npm test` | exit 0, same pass count as before |

Never open `workflows/*.json` directly.

## Scope

**In scope**:
- `src/build_workflows.py`
- `src/assistant/route_update.js`, `src/assistant/parse_agent_output.js`, `src/assistant/callback_outcome.js`
- `workflows/workflow_assistant.json` (regenerated only — jsCode changes)

**Out of scope**:
- Changing any numeric value or the order of Switch outputs.
- `tests/code_nodes.test.js` (must pass unmodified).
- `scripts/audit-invariants.py`.

## Git workflow

- Branch: `advisor/005-route-index-contract`
- One commit incl. regenerated JSON, e.g. `Declare Switch route indices once and check them at build time`.
- Do NOT push.

## Steps

### Step 1: Record the baseline

`cd tests && npm test 2>&1 | grep passed` → note the count (e.g. `57 passed`).

### Step 2: Declare the mappings in the generator

Near the top constants (after `PRIMARY_CAL`, ~line 31):
```python
# Switch output indices. The Code node that feeds each Switch must contain the
# identical JS constant (checked by code()), so JS and wiring cannot drift.
ROUTE = {"voice": 0, "text": 1, "callback": 2}      # "Route update" -> "Route"
REPLY = {"voice": 0, "text": 1}                      # "Parse + validate" -> "Voice or text?"
OUTCOME = {"create": 0, "cardOnly": 1}               # "Decision outcome" -> "Approved?" (0 = write gate, audited)


def js_const(name, mapping):
    return f"const {name} = {{ " + ", ".join(f"{k}: {v}" for k, v in mapping.items()) + " };"
```

Change `code()`:
```python
def code(rel, **consts):
    src = read(rel)
    for name, mapping in consts.items():
        decl = js_const(name, mapping)
        assert decl in src, f"src/{rel}: must declare `{decl}` (generator wiring depends on it)"
    return {"jsCode": src}
```

**Verify**: `py src/build_workflows.py` → exit 0 (no caller passes consts yet).

### Step 3: Use the constants in the JS

- `route_update.js`: after the header comment add
  `const ROUTE = { voice: 0, text: 1, callback: 2 };`
  and replace `route: 2` → `route: ROUTE.callback`, both `route: 1` → `route: ROUTE.text`,
  `route: 0` → `route: ROUTE.voice`. Update the header comment to
  `// Output \`route\`: see ROUTE (must match ROUTE in src/build_workflows.py).`
- `parse_agent_output.js`: near `MAX_PROPOSALS` add
  `const REPLY = { voice: 0, text: 1 };` and change line 123 to
  `replyRoute: wantsText ? REPLY.text : REPLY.voice,   // must match REPLY in src/build_workflows.py`
- `callback_outcome.js`: after the header comment add
  `const OUTCOME = { create: 0, cardOnly: 1 };`; `let route = OUTCOME.cardOnly;`;
  `route = OUTCOME.create;`. Update comment line 4 to reference `OUTCOME`.

The declaration lines must match `js_const()` output exactly: `const NAME = { k: v, k: v };`
(one space inside braces, `, ` separators, trailing `;`).

**Verify**: `grep -rnE "route: [0-9]|route = [0-9]|\? 1 : 0" src/assistant` → no matches.
`cd tests && npm test` → same pass count as Step 1.

### Step 4: Wire the generator through the constants

- `code("assistant/route_update.js")` → `code("assistant/route_update.js", ROUTE=ROUTE)`
- `code("assistant/parse_agent_output.js")` → `code(..., REPLY=REPLY)`
- `code("assistant/callback_outcome.js")` → `code(..., OUTCOME=OUTCOME)`
- `"numberOutputs": 3` (Route) → `len(ROUTE)`; both `"numberOutputs": 2` for
  `Voice or text?` / `Approved?` → `len(REPLY)` / `len(OUTCOME)`.
- Replace literal indices in the wiring block:
  `w.link("Route", "Show typing", ROUTE["voice"])`, `("Get voice file path", ROUTE["voice"])`,
  `("Show typing", ROUTE["text"])`, `("Prepare agent input", ROUTE["text"])`,
  `("Claim decision", ROUTE["callback"])`;
  `("Speak reply", REPLY["voice"])`, `("Send text reply", REPLY["text"])`;
  `("Create calendar event", OUTCOME["create"])`, `("Answer button", OUTCOME["cardOnly"])`,
  `("Update card", OUTCOME["cardOnly"])`.
  Leave `w.link("Create calendar event", "Mark executed", 0)` / `("Mark failed", 1)` — those are
  n8n's success/error outputs, not a Code-node route.

**Verify**: `py src/build_workflows.py` → exit 0; `git diff --stat workflows/` → only
`workflow_assistant.json` changed. `py scripts/audit-invariants.py` → all PASS.

### Step 5: Prove the check fires (temporary, then revert)

Change `const REPLY = { voice: 0, text: 1 };` to `{ voice: 1, text: 0 }` in
`parse_agent_output.js`, run the build, then revert.

**Verify**: build exits non-zero with `src/assistant/parse_agent_output.js: must declare`.
After reverting: build exit 0.

## Test plan

Existing `tests/code_nodes.test.js` covers every route value and must pass
unmodified with the same count. Step 5 proves the new build-time contract.

## Done criteria

- [ ] `cd tests && npm test` exits 0 with the Step 1 pass count
- [ ] `py src/build_workflows.py` exits 0
- [ ] `py scripts/audit-invariants.py` exits 0, `writes only after 'Approved?' output 0: PASS`
- [ ] `grep -nE 'w.link\("(Route|Voice or text\?|Approved\?)", "[^"]+", [0-9]' src/build_workflows.py` → no matches
- [ ] `git diff --name-only` ⊆ in-scope list + `plans/README.md`

## STOP conditions

- Any test in `tests/code_nodes.test.js` fails — a numeric value changed.
- The audit's `Approved?` gate check fails.
- `git diff workflows/` touches anything beyond jsCode of the three nodes and
  (no-op) `numberOutputs`; e.g. connections reorder. Report the diff summary.

## Maintenance notes

- Adding a new route: add the key in the Python dict AND the JS constant, in
  the same position; the build enforces equality of the whole declaration.
- `OUTCOME.create` must stay `0`: `scripts/audit-invariants.py` hard-codes
  output 0 as the approval write gate.
