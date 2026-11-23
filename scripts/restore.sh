#!/usr/bin/env bash
# Restores (or just verifies) a backup made by scripts/backup.sh.
#
#   scripts/restore.sh --identity jarvis-backup.key --latest            # VERIFY only (default)
#   scripts/restore.sh --identity jarvis-backup.key FILE.tar.age        # VERIFY a given file
#   scripts/restore.sh --identity jarvis-backup.key --latest --apply    # REPLACE the live database
#
# VERIFY decrypts, restores into a throwaway database (restore_verify) next to the live one,
# counts workflows/credentials, checks the assistant schema, then drops it. Nothing live changes.
# Run it after setting up backups and every few months: a backup you never restored is a hope.
#
# APPLY replaces the live database. It asks you to type "restore", stops n8n first, and never
# overwrites .env: the backed-up copy is written to .env.restored. If the backup's
# N8N_ENCRYPTION_KEY differs from the current one, it is adopted into .env only when no n8n
# data volume exists yet (a fresh server). Otherwise APPLY refuses before touching anything.
#
# Disaster recovery on a fresh server:
#   scripts/bootstrap-vps.sh --domain your.domain
#   rclone copy <remote>/jarvis-XXXX.tar.age .      # or scp it
#   docker compose up -d postgres
#   scripts/restore.sh --identity jarvis-backup.key jarvis-XXXX.tar.age --apply
#   docker compose --profile cloud up -d --build
#   # then republish the assistant workflow so Telegram's webhook is registered
source "$(dirname "$0")/_lib.sh"
umask 077

IDENTITY=""; ARCHIVE=""; LATEST=0; APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) IDENTITY="${2:-}"; shift 2 ;;
    --latest)   LATEST=1; shift ;;
    --apply)    APPLY=1; shift ;;
    -h|--help)  sed -n '2,22p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *)  ARCHIVE="$1"; shift ;;
  esac
done

WORK=""
cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -qc "drop database if exists restore_verify with (force)"' >/dev/null 2>&1 || true; }
trap cleanup EXIT
bail() { fail "restore" "$1"; exit 1; }

[ -n "$IDENTITY" ] && [ -r "$IDENTITY" ] || bail "--identity KEYFILE is required and must be readable (the age private key)"
command -v age >/dev/null 2>&1 || bail "age not installed (apt-get install age)"
if [ "$LATEST" = 1 ]; then
  dir="$(env_get BACKUP_DIR)"; dir="${dir:-/var/backups/jarvis}"
  ARCHIVE="$(find "$dir" -maxdepth 1 -name 'jarvis-*.tar.age' -type f 2>/dev/null | sort | tail -n 1)"
  [ -n "$ARCHIVE" ] || bail "no jarvis-*.tar.age in $dir"
fi
[ -n "$ARCHIVE" ] && [ -r "$ARCHIVE" ] || bail "give an archive path or --latest"

WORK="$(mktemp -d)" || bail "mktemp failed"
age -d -i "$IDENTITY" "$ARCHIVE" 2>"$WORK/age.err" | tar -C "$WORK" -xf - 2>>"$WORK/age.err" \
  || bail "cannot decrypt/extract (wrong key or corrupt file)"
for f in db.dump env manifest.txt; do [ -s "$WORK/$f" ] || bail "archive is missing $f"; done
pass "decrypt" "$(basename "$ARCHIVE")"
info "backup created" "$(grep '^created_utc=' "$WORK/manifest.txt" | cut -d= -f2)"

psql_live() { docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -tA' ; }

# ── VERIFY ───────────────────────────────────────────────────
if [ "$APPLY" = 0 ]; then
  echo 'drop database if exists restore_verify with (force); create database restore_verify;' | psql_live >/dev/null \
    || bail "cannot create scratch database (is postgres running?)"
  docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d restore_verify --no-owner --exit-on-error' < "$WORK/db.dump" 2>"$WORK/restore.err" \
    || bail "pg_restore into scratch database failed: $(head -c 300 "$WORK/restore.err")"
  q() { docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d restore_verify -tAc \"$1\"" 2>/dev/null | tr -d '[:space:]'; }
  wf="$(q 'select count(*) from workflow_entity')"
  cr="$(q 'select count(*) from credentials_entity')"
  sch="$(q "select to_regclass('assistant.proposals') is not null")"
  [ "${wf:-0}" -ge 1 ] 2>/dev/null && pass "workflows in backup" "$wf" || fail "workflows in backup" "none found"
  pass "credentials in backup" "${cr:-?}"
  [ "$sch" = "t" ] && pass "schema assistant.proposals" || fail "schema assistant.proposals" "missing from backup"
  key_backup="$(grep -E '^N8N_ENCRYPTION_KEY=' "$WORK/env" | tail -n 1 | cut -d= -f2-)"
  [ "${#key_backup}" -ge 32 ] && pass "N8N_ENCRYPTION_KEY in backup" "present" || fail "N8N_ENCRYPTION_KEY in backup" "missing or too short"
  [ "$FAILED" = 0 ] && echo "verify OK. Live data untouched. Re-run with --apply to replace it."
  exit "$FAILED"
fi

# ── APPLY ────────────────────────────────────────────────────
key_backup="$(grep -E '^N8N_ENCRYPTION_KEY=' "$WORK/env" | tail -n 1 | cut -d= -f2-)"
[ "${#key_backup}" -ge 32 ] || bail "backup has no usable N8N_ENCRYPTION_KEY"
key_now="$(env_get N8N_ENCRYPTION_KEY)"
adopt=0
if [ "$key_now" != "$key_backup" ]; then
  if docker volume ls --format '{{.Name}}' 2>/dev/null | grep -q 'n8n_data$'; then
    bail "N8N_ENCRYPTION_KEY differs and an n8n data volume already exists; n8n would refuse to start. Restore on a fresh server, or put the backed-up key in .env yourself (see .env.restored after a verify of a copy)"
  fi
  adopt=1
fi

echo "This REPLACES the live database '$(env_get POSTGRES_DB)' with the backup from $(grep '^created_utc=' "$WORK/manifest.txt" | cut -d= -f2)."
printf 'Type "restore" to continue: '
read -r answer < /dev/tty 2>/dev/null || answer=""
[ "$answer" = "restore" ] || bail "aborted, nothing changed"

docker compose stop n8n >/dev/null 2>&1 || true
db="$(env_get POSTGRES_DB)"; user="$(env_get POSTGRES_USER)"
case "$db$user" in *[!a-zA-Z0-9_]*|"") bail "POSTGRES_DB/POSTGRES_USER must be plain identifiers" ;; esac
printf 'drop database if exists "%s" with (force);\ncreate database "%s" owner "%s";\n' "$db" "$db" "$user" | psql_live >/dev/null \
  || bail "could not recreate database (is postgres running? docker compose up -d postgres)"
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < "$WORK/db.dump" 2>"$WORK/restore.err" \
  || bail "pg_restore failed: $(head -c 300 "$WORK/restore.err"). The database is now empty; fix the cause and re-run"
pass "database restored" "$db"

cp "$WORK/env" "$ROOT/.env.restored"; chmod 600 "$ROOT/.env.restored"
info ".env.restored" "backed-up .env written next to the live one (never auto-applied)"
if [ "$adopt" = 1 ]; then
  tmp="$(mktemp)"
  awk -v k=N8N_ENCRYPTION_KEY -v v="$key_backup" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' "$ENV_FILE" > "$tmp" && cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  pass "N8N_ENCRYPTION_KEY" "adopted from backup (fresh server)"
else
  pass "N8N_ENCRYPTION_KEY" "already matches"
fi
echo "next: docker compose --profile cloud up -d --build, then republish the assistant workflow (Telegram webhook)"
exit "$FAILED"
