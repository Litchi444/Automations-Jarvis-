#!/usr/bin/env bash
# Installs a systemd timer that runs scripts/backup.sh every day (default 03:15 server time).
# Run as root on the server, after BACKUP_AGE_RECIPIENT is set in .env.
#
#   sudo scripts/install-backup-timer.sh                 # install + enable
#   sudo scripts/install-backup-timer.sh --time 04:30    # other hour (HH:MM, server time)
#   scripts/install-backup-timer.sh --dry-run            # print the units only
#   sudo scripts/install-backup-timer.sh --remove
#
# Status:  systemctl list-timers jarvis-backup.timer   |   journalctl -u jarvis-backup -n 30
set -euo pipefail

TIME="03:15"; DRY=0; REMOVE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --time) TIME="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --remove) REMOVE=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$TIME" in [0-2][0-9]:[0-5][0-9]) ;; *) echo "error: --time must be HH:MM" >&2; exit 2 ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR=/etc/systemd/system

service_unit() {
cat <<EOF
[Unit]
Description=Jarvis encrypted backup
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
WorkingDirectory=$ROOT
ExecStart=$ROOT/scripts/backup.sh
Nice=10
EOF
}
timer_unit() {
cat <<EOF
[Unit]
Description=Daily Jarvis backup

[Timer]
OnCalendar=*-*-* $TIME:00
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

if [ "$DRY" = 1 ]; then
  echo "# $UNIT_DIR/jarvis-backup.service"; service_unit; echo
  echo "# $UNIT_DIR/jarvis-backup.timer";   timer_unit
  exit 0
fi

[ "$(id -u)" = 0 ] || { echo "error: run as root (sudo)" >&2; exit 1; }

if [ "$REMOVE" = 1 ]; then
  systemctl disable --now jarvis-backup.timer 2>/dev/null || true
  rm -f "$UNIT_DIR/jarvis-backup.service" "$UNIT_DIR/jarvis-backup.timer"
  systemctl daemon-reload
  echo "removed"; exit 0
fi

grep -Eq '^BACKUP_AGE_RECIPIENT=age1' "$ROOT/.env" 2>/dev/null \
  || { echo "error: set BACKUP_AGE_RECIPIENT=age1... in .env first (see scripts/backup.sh header)" >&2; exit 1; }

service_unit > "$UNIT_DIR/jarvis-backup.service"
timer_unit   > "$UNIT_DIR/jarvis-backup.timer"
systemctl daemon-reload
systemctl enable --now jarvis-backup.timer
echo "installed. Run one now to check:  systemctl start jarvis-backup.service && journalctl -u jarvis-backup -n 20"
systemctl list-timers jarvis-backup.timer --no-pager | head -3
