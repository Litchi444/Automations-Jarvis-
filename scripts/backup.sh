#!/usr/bin/env bash
# Encrypted backup of everything Jarvis cannot rebuild from git:
#   - the whole Postgres database (n8n workflows, encrypted credentials, the
#     assistant.* schema, chat memory)   -> pg_dump -Fc
#   - .env (holds N8N_ENCRYPTION_KEY: without it the credentials in the dump are unreadable)
# Both go into one tar, encrypted with age to a PUBLIC key. The server never holds
# the private key, so a stolen server or a stolen backup reveals nothing.
#
# Setup, once, on YOUR machine (not the server):
#   age-keygen -o jarvis-backup.key        # keep this file safe (password manager + paper)
#   # copy the "Public key: age1..." line into BACKUP_AGE_RECIPIENT in .env
#
# Config in .env (see .env.example):
#   BACKUP_AGE_RECIPIENT   required, age1... public key
#   BACKUP_DIR             default /var/backups/jarvis
#   BACKUP_KEEP_DAYS       default 14 (local copies)
#   BACKUP_RCLONE_REMOTE   optional, e.g. b2:my-bucket/jarvis (off-server copy; rclone must be configured)
#   BACKUP_REMOTE_KEEP_DAYS default 30
#
# Usage: scripts/backup.sh          (run daily via scripts/install-backup-timer.sh)
# On failure it sends a Telegram message (no secrets in it) and exits non-zero.
source "$(dirname "$0")/_lib.sh"
umask 077

AGE_RECIPIENT="$(env_get BACKUP_AGE_RECIPIENT)"
BACKUP_DIR="$(env_get BACKUP_DIR)";                  BACKUP_DIR="${BACKUP_DIR:-/var/backups/jarvis}"
KEEP_DAYS="$(env_get BACKUP_KEEP_DAYS)";             KEEP_DAYS="${KEEP_DAYS:-14}"
REMOTE="$(env_get BACKUP_RCLONE_REMOTE)"
REMOTE_KEEP_DAYS="$(env_get BACKUP_REMOTE_KEEP_DAYS)"; REMOTE_KEEP_DAYS="${REMOTE_KEEP_DAYS:-30}"

STEP="start"
WORK=""
cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; }
trap cleanup EXIT

alert() { # message → Telegram, token passed through stdin so it never shows in `ps`
  local token chat
  token="$(env_get TELEGRAM_BOT_TOKEN)"; chat="$(env_get TELEGRAM_CHAT_ID)"
  [ -n "$token" ] && [ -n "$chat" ] || return 0
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" \
    | curl -sS -m 15 -K - --data-urlencode "chat_id=$chat" --data-urlencode "text=$1" >/dev/null 2>&1 || true
}
die() { fail "backup" "$1"; alert "Jarvis backup FAILED at step: $STEP. Check: journalctl -u jarvis-backup (or run scripts/backup.sh)."; exit 1; }

STEP="config"
case "$AGE_RECIPIENT" in age1*) ;; *) die "BACKUP_AGE_RECIPIENT missing or not an age1... public key" ;; esac
case "$KEEP_DAYS$REMOTE_KEEP_DAYS" in *[!0-9]*|"") die "BACKUP_KEEP_DAYS / BACKUP_REMOTE_KEEP_DAYS must be integers" ;; esac
command -v age >/dev/null 2>&1 || die "age not installed (apt-get install age)"
[ -f "$ENV_FILE" ] || die ".env not found"
if [ -n "$REMOTE" ]; then command -v rclone >/dev/null 2>&1 || die "BACKUP_RCLONE_REMOTE set but rclone is not installed"; fi

# One run at a time (timer + manual run).
exec 9>"$ROOT/.backup.lock"
flock -n 9 || die "another backup is already running"

STEP="prepare"
mkdir -p "$BACKUP_DIR" || die "cannot create $BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
WORK="$(mktemp -d)" || die "mktemp failed"

STEP="database dump"
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$WORK/db.dump" 2>"$WORK/dump.err" \
  || die "pg_dump failed (is the stack running?)"
[ -s "$WORK/db.dump" ] || die "pg_dump produced an empty file"
# A dump that cannot be listed cannot be restored.
docker compose exec -T postgres pg_restore -l < "$WORK/db.dump" > "$WORK/db.toc" 2>/dev/null \
  || die "dump failed the pg_restore -l integrity check"
grep -q 'workflow_entity' "$WORK/db.toc" || die "dump has no n8n tables (wrong database?)"
pass "database dump" "$(du -h "$WORK/db.dump" | cut -f1)"

STEP="collect files"
cp "$ENV_FILE" "$WORK/env"
{
  echo "created_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "n8n_version=$(env_get N8N_VERSION)"
  echo "host=$(env_get N8N_HOST)"
  echo "format=1"
} > "$WORK/manifest.txt"

STEP="encrypt"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/jarvis-$STAMP.tar.age"
tar -C "$WORK" -cf - db.dump env manifest.txt | age -r "$AGE_RECIPIENT" -o "$OUT.part" \
  || { rm -f "$OUT.part"; die "tar/age failed"; }
[ -s "$OUT.part" ] || { rm -f "$OUT.part"; die "encrypted archive is empty"; }
mv "$OUT.part" "$OUT"
pass "encrypted archive" "$(basename "$OUT"), $(du -h "$OUT" | cut -f1)"

STEP="local retention"
find "$BACKUP_DIR" -maxdepth 1 -name 'jarvis-*.tar.age' -type f -mtime "+$KEEP_DAYS" -delete
pass "local retention" "kept ${KEEP_DAYS} days, $(find "$BACKUP_DIR" -maxdepth 1 -name 'jarvis-*.tar.age' | wc -l) file(s)"

if [ -n "$REMOTE" ]; then
  STEP="off-server copy"
  rclone copyto "$OUT" "$REMOTE/$(basename "$OUT")" >"$WORK/rclone.log" 2>&1 \
    || die "rclone upload to $REMOTE failed"
  pass "off-server copy" "$REMOTE"
  STEP="remote retention"
  rclone delete "$REMOTE" --min-age "${REMOTE_KEEP_DAYS}d" --include 'jarvis-*.tar.age' >/dev/null 2>&1 \
    || fail "remote retention" "could not prune $REMOTE (backup itself is fine)"
else
  skip "off-server copy" "BACKUP_RCLONE_REMOTE unset: backups only live on this server"
fi

exit "$FAILED"
