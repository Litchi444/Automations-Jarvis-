#!/usr/bin/env bash
# Shared helpers for agent-facing scripts.
# Rules: never print secret values; keep output to a few PASS/FAIL lines.
set -uo pipefail
# Git Bash on Windows rewrites container paths (/usr/local/bin/…) into host paths
# in docker arguments. Turn that off; the variable is ignored everywhere else.
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2
ENV_FILE="$ROOT/.env"

# env_get KEY → value from .env (last occurrence), quotes stripped. Prints nothing if absent.
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  local line
  line="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n 1)" || true
  line="${line#*=}"
  line="${line%$'\r'}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

pass() { printf '%-34s PASS%s\n' "$1:" "${2:+ ($2)}"; }
fail() { printf '%-34s FAIL%s\n' "$1:" "${2:+ ($2)}"; FAILED=1; }
skip() { printf '%-34s SKIP%s\n' "$1:" "${2:+ ($2)}"; }
info() { printf '%-34s %s\n' "$1:" "$2"; }
FAILED=0
