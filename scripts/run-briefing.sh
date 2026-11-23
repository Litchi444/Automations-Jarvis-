#!/usr/bin/env bash
# Runs the Morning Briefing once via the n8n CLI and prints ONLY the verdict.
# The raw output holds base64 audio. It stays in a temp file and never reaches the terminal.
source "$(dirname "$0")/_lib.sh"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
start=$(date +%s)
docker compose exec -T n8n n8n execute --id=mbMorningBrief01 >"$tmp" 2>&1
rc=$?
secs=$(( $(date +%s) - start ))

errors="$(grep -aiE 'error|failed|problem|invalid|not found|unauthor|forbidden|quota|429' "$tmp" \
  | grep -avE '^\s*"' | cut -c1-200 | sort -u | head -n 5)"

if [ "$rc" -eq 0 ] && [ -z "$errors" ]; then
  pass "run-briefing" "${secs}s; a voice note should have arrived on Telegram"
else
  fail "run-briefing" "exit $rc after ${secs}s"
  [ -n "$errors" ] && printf '%s\n' "$errors" | sed 's/^/  > /'
  grep -aqiE 'credential' "$tmp" && echo "  hint: a node has no/invalid credential (human checkpoint H1)"
  grep -aqiE 'not published|unpublished|could not find workflow' "$tmp" && echo "  hint: publish Speak (mbSpeakVoiceNote) and restart n8n"
fi
exit "$FAILED"
