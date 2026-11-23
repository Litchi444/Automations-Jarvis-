#!/usr/bin/env bash
# Fills N8N_ENCRYPTION_KEY / POSTGRES_PASSWORD in .env ONLY if they are still
# placeholders, and ONLY if no data volume exists yet (changing them later
# would lock you out of existing credentials / the database). Never prints values.
source "$(dirname "$0")/_lib.sh"
[ -f "$ENV_FILE" ] || { echo "env file: MISSING (cp .env.example .env first)"; exit 1; }

rand() { openssl rand -hex 32 2>/dev/null || python3 -c 'import secrets;print(secrets.token_hex(32))'; }
volume_exists() { docker volume ls --format '{{.Name}}' 2>/dev/null | grep -q "$1\$"; }

replace() { # key
  local key="$1" new tmp
  new="$(rand)" || { fail "$key" "no openssl/python3 to generate"; return; }
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$new" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' "$ENV_FILE" > "$tmp" && cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
  pass "$key" "generated"
}

for pair in "N8N_ENCRYPTION_KEY:n8n_data" "POSTGRES_PASSWORD:postgres_data"; do
  key="${pair%%:*}"; vol="${pair##*:}"
  v="$(env_get "$key")"
  case "$v" in
    *change-me*|"")
      if volume_exists "$vol"; then
        fail "$key" "placeholder but volume *$vol exists; refusing (would break existing data)"
      else
        replace "$key"
      fi ;;
    *) skip "$key" "already set, left untouched" ;;
  esac
done
[ "$FAILED" = 0 ] && echo "reminder: back up N8N_ENCRYPTION_KEY somewhere other than this machine"
exit "$FAILED"
