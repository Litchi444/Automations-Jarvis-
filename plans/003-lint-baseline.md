# Plan 003: Add a lint baseline for Code-node JS and the Python generator/audit

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 8f6b212..HEAD -- tests/package.json src/ scripts/audit-invariants.py`
> If anything changed, re-run Step 1's dry run before trusting the counts below.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (independent of 001/002; if they landed, lint their code too)
- **Category**: dx
- **Planned at**: commit `8f6b212`, 2026-11-27

## Why this matters

The JS files in `src/` are pasted verbatim into n8n Code nodes. A typo'd
variable or an unused leftover is only discovered when n8n executes the node
in production (e.g. on a 07:30 briefing). There is no linter, no type check,
no formatter and no CI in this repo. A lint pass that understands the n8n
Code-node environment (globals `$`, `$input`, `$env`, `Buffer`, and a
top-level `return`) catches `no-undef` / `no-unused-vars` class bugs at
edit time. Python gets the same with `ruff check`.

## Current state

- `tests/package.json` — the only Node manifest (CommonJS, devDeps
  `embedded-postgres`, `pg`); scripts `test:code`, `test:sql`, `test`.
  ```json
  "scripts": {
    "test:code": "node code_nodes.test.js",
    "test:sql": "node sql.test.mjs",
    "test": "npm run test:code && npm run test:sql"
  }
  ```
- Code-node sources (11 files): `src/*.js`, `src/assistant/*.js`,
  `src/unimail/*.js`. Each is a **function body**, not a module: it ends with
  a top-level `return [...]`, and uses n8n-provided globals. Counted usage in
  `src/**/*.js`: `$(` ×10, `$input` ×7, `Buffer` ×3, `$env` ×2. No `require`,
  no `process`. Example `src/assistant/prepare_agent_input.js:4-5,18`:
  ```js
  const r = $('Route update').first().json;
  ...
  return [{ json: { ... } }];
  ```
- Tests: `tests/code_nodes.test.js` (CommonJS, Node globals) and
  `tests/sql.test.mjs` (ES module).
- Python: `src/build_workflows.py`, `scripts/audit-invariants.py`
  (uses `# noqa: E402` already — ruff-compatible).
- Why not `tsc --checkJs`: TypeScript rejects a top-level `return` in a
  script (error TS1108), which every Code-node file has. Do not add tsc in
  this plan.
- Windows note: the maintainer runs Windows + Git Bash; use `py` for Python
  where `python3` is the Store stub. Commands below give both.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `cd tests && npm install` | exit 0 |
| JS lint | `cd tests && npm run lint` | exit 0, no output besides npm header |
| Python lint | `py -m ruff check src scripts` or `python3 -m ruff check src scripts` (needs `pip install ruff`), or `uvx ruff check src scripts` | `All checks passed!` |
| Tests | `cd tests && npm test` | exit 0 |
| Build | `py src/build_workflows.py` | exit 0, `git status workflows/` empty |

## Scope

**In scope**:
- `tests/package.json` (devDeps + `lint` script)
- `tests/package-lock.json` (updated by `npm install`)
- `tests/eslint.config.mjs` (create)
- `ruff.toml` at repo root (create)
- Minimal fixes in `src/**/*.js`, `tests/*.js|mjs`, `src/build_workflows.py`,
  `scripts/audit-invariants.py` **only** for real lint errors (see STOP).

**Out of scope**:
- `workflows/*.json` (generated; never open).
- Formatting-only rewrites (no Prettier / `ruff format` in this plan).
- `scripts/*.sh` (shellcheck is a separate follow-up).
- Adding CI.

## Git workflow

- Branch: `advisor/003-lint-baseline`
- Commit 1: config + script. Commit 2 (only if needed): lint fixes.
  Message style: `Add ESLint and ruff lint baseline`.
- Do NOT push.

## Steps

### Step 1: Add ESLint

`cd tests && npm install --save-dev eslint@^9 globals@^15 @eslint/js@^9`

Create `tests/eslint.config.mjs`:
```js
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    // n8n Code nodes: a function body with n8n globals and a top-level return.
    files: ['../src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      parserOptions: { ecmaFeatures: { globalReturn: true } },
      globals: { $: 'readonly', $input: 'readonly', $env: 'readonly', Buffer: 'readonly' },
    },
  },
  {
    files: ['*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  {
    files: ['*.mjs'],
    languageOptions: { sourceType: 'module', globals: globals.node },
  },
];
```

Add to `tests/package.json` scripts: `"lint": "eslint . ../src"`.

ESLint 9 refuses files outside its base dir by default. If
`npm run lint` reports `File ignored because outside of base path`, move the
config to the repo root as `eslint.config.mjs` (adjust globs: `src/**/*.js`,
`tests/*.js`, `tests/*.mjs`) and set the script to
`"lint": "eslint --config ../eslint.config.mjs .. --ignore-pattern '../tests/node_modules/**' --ignore-pattern '../workflows/**'"`.
Prefer whichever variant passes with the least config; record which in the commit message.

**Verify**: `cd tests && npx eslint --print-config ../src/clean_script.js | grep -c globalReturn` → `1`.

### Step 2: Run ESLint and triage

`cd tests && npm run lint`

For each reported problem:
- `no-undef` on an n8n global not listed above (e.g. `$execution`, `$now`) →
  add it to the globals map, it is legitimate.
- `no-unused-vars`, real `no-undef` typos, `no-useless-escape` → fix in source
  with the smallest edit.

**Verify**: `npm run lint` → exit 0. Then `cd .. && py src/build_workflows.py`
→ exit 0, and `cd tests && npm test` → exit 0.

### Step 3: Add ruff

Create `ruff.toml` at repo root:
```toml
target-version = "py311"
line-length = 120
exclude = ["tests/node_modules", "workflows"]

[lint]
select = ["E", "F", "W", "B"]
```

Check `py --version`; set `target-version` to that minor version if older
than 3.11 — but note `itertools.pairwise` (used in `src/build_workflows.py:58`)
needs ≥ 3.10.

**Verify**: `py -m ruff check src scripts` → `All checks passed!` (fix real
findings with minimal edits; `E501` on long string literals in
`build_workflows.py` may be silenced by adding `"E501"` to `ignore` instead of
rewrapping prompt text).

### Step 4: Document

In `CLAUDE.md` section `## Commands`, add one line after `npm test`:
`cd tests && npm run lint` and `py -m ruff check src scripts`.
In `## Rules`, extend "After changes: `cd tests && npm test` must pass." to
"... and `npm run lint` must pass."

**Verify**: `grep -n "npm run lint" CLAUDE.md` → 2 matches.

## Test plan

Lint is the deliverable. Re-run `npm test`, build and
`py scripts/audit-invariants.py` after any source fix; all must stay green
and `git status workflows/` must show only expected changes (a source fix
changes the embedded jsCode — that is fine; commit the regenerated JSON with it).

## Done criteria

- [ ] `cd tests && npm run lint` exits 0
- [ ] `py -m ruff check src scripts` (or equivalent) → `All checks passed!`
- [ ] `cd tests && npm test` exits 0
- [ ] `py scripts/audit-invariants.py` exits 0, all PASS
- [ ] `grep -n "npm run lint" CLAUDE.md` → 2 matches
- [ ] No `eslint-disable` comments added to `src/` (`grep -rn eslint-disable src` → empty)

## STOP conditions

- A lint "fix" would change Code-node behavior (not just remove dead code or
  fix an obvious typo). Report it instead.
- More than ~15 real findings — report the list; the baseline may need a
  narrower rule set agreed with the maintainer.
- ESLint cannot be made to parse a top-level `return` in `src/` with either
  config variant.

## Maintenance notes

- New n8n globals used in Code nodes must be added to the globals map.
- Type checking is deliberately deferred: it would need each Code-node file
  wrapped in a function for tsc (TS1108). Revisit only if bugs slip past lint.
- Natural follow-ups: shellcheck for `scripts/*.sh`, a GitHub Actions job
  running build + audit + test + lint.
