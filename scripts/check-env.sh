#!/usr/bin/env bash
# Validates .env WITHOUT printing secret values. Exit 0 = ready.
source "$(dirname "$0")/_lib.sh"

if [ ! -f "$ENV_FILE" ]; then
  echo "env file: MISSING (run: cp .env.example .env)"; exit 1
fi

is_placeholder() {
  case "$1" in
    *change-me*|"123456789:AA-your-bot-token"|"123456789") return 0 ;;
    *) return 1 ;;
  esac
}

check() { # key, regex-validator (optional), hint
  local key="$1" re="${2:-}" hint="${3:-}" v
  v="$(env_get "$key")"
  if [ -z "$v" ]; then fail "$key" "missing${hint:+; $hint}"; return; fi
  if is_placeholder "$v"; then fail "$key" "placeholder${hint:+; $hint}"; return; fi
  if [ -n "$re" ] && ! printf '%s' "$v" | grep -Eq "$re"; then fail "$key" "bad format${hint:+; $hint}"; return; fi
  pass "$key"
}

check N8N_ENCRYPTION_KEY '^.{32,}$' "≥32 chars; ./scripts/gen-secrets.sh"
check POSTGRES_PASSWORD  '^.{16,}$' "≥16 chars; ./scripts/gen-secrets.sh"
check POSTGRES_USER
check POSTGRES_DB
check GENERIC_TIMEZONE   '^[A-Za-z_]+/[A-Za-z_]+' "e.g. Europe/Paris"
check N8N_HOST
check N8N_PROTOCOL       '^https?$'
check WEBHOOK_URL        '^https?://.+/$' "must end with /"
check TELEGRAM_BOT_TOKEN '^[0-9]{6,}:[A-Za-z0-9_-]{30,}$' "from @BotFather"
check TELEGRAM_CHAT_ID   '^-?[0-9]{5,}$' "from @userinfobot"

proto="$(env_get N8N_PROTOCOL)"
url="$(env_get WEBHOOK_URL)"
if [ "$proto" = "https" ]; then
  info "MODE" "cloud (use: docker compose --profile cloud up -d --build)"
  case "$url" in https://*) pass "WEBHOOK_URL is https" ;; *) fail "WEBHOOK_URL is https" "protocol is https but URL is not" ;; esac
else
  info "MODE" "local (assistant needs a public HTTPS URL or a tunnel; briefing works)"
fi
info "editor URL" "${url:-unknown}"
[ -n "$(env_get N8N_API_KEY)" ] && info "N8N_API_KEY (optional)" "set" || info "N8N_API_KEY (optional)" "unset: execution summaries disabled"

exit "$FAILED"
