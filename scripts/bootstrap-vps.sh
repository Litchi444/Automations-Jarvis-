#!/usr/bin/env bash
# Prepares a FRESH Debian 12/13 or Ubuntu 22.04+ VPS (Hetzner, OVH, Contabo, ...)
# to run Jarvis behind Caddy + HTTPS. Run as root, from inside the cloned repo:
#
#   apt-get update && apt-get install -y git
#   git clone <your repo url> && cd Automations-Jarvis-
#   sudo scripts/bootstrap-vps.sh --domain jarvis.example.com
#
# What it does (each step is idempotent, safe to re-run):
#   1. apt upgrade + unattended security updates
#   2. Docker Engine + Compose v2 (official get.docker.com script)
#   3. swap file (default 2G) when the box has none
#   4. ufw: deny incoming, allow 22/80/443
#   5. .env from .env.example, URL settings for your domain, secrets via gen-secrets.sh
#   6. DNS sanity check (warn only)
#   7. with --start: build and start the stack (cloud profile)
#
# It never prints secret values and never touches TELEGRAM_* (you fill those).
# Options:
#   --domain NAME   public DNS name pointing at this server (required)
#   --swap SIZE     swap size, e.g. 2G (default 2G, 0 to skip)
#   --start         build + start the stack if .env is complete
#   --dry-run       print what would run, change nothing
set -euo pipefail

DOMAIN=""; SWAP="2G"; START=0; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --swap)   SWAP="${2:-}";   shift 2 ;;
    --start)  START=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
WARN=0

log()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    ok: %s\n' "$*"; }
warn() { printf '    WARN: %s\n' "$*"; WARN=1; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf '    [dry-run] %s\n' "$*"; else "$@"; fi; }

# ── preflight ────────────────────────────────────────────────
[ -n "$DOMAIN" ] || die "--domain is required (Google OAuth rejects raw IPs; a free DuckDNS name works)"
case "$DOMAIN" in
  *[!a-zA-Z0-9.-]*|.*|*.|*..*|"") die "invalid domain: $DOMAIN" ;;
esac
case "$DOMAIN" in *.*) ;; *) die "domain must contain a dot: $DOMAIN" ;; esac
case "$SWAP" in 0|[0-9]*[MG]) ;; *) die "--swap must be 0 or like 512M / 2G" ;; esac
[ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ -f "$ROOT/docker-compose.yml" ] || die "run from inside the cloned repo"

if [ -r /etc/os-release ]; then
  . /etc/os-release
  case "${ID:-}" in
    debian|ubuntu) ok "OS: ${PRETTY_NAME:-$ID}" ;;
    *) warn "untested OS '${ID:-unknown}': this script targets Debian/Ubuntu" ;;
  esac
fi

# ── 1. system updates ────────────────────────────────────────
log "System packages and unattended security updates"
export DEBIAN_FRONTEND=noninteractive
run apt-get update -qq
run apt-get upgrade -y -qq
run apt-get install -y -qq ca-certificates curl openssl python3 ufw unattended-upgrades
run systemctl enable --now unattended-upgrades

# ── 2. Docker ────────────────────────────────────────────────
log "Docker Engine + Compose v2"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "already installed: $(docker --version)"
else
  if [ "$DRY" = 1 ]; then
    echo "    [dry-run] curl -fsSL https://get.docker.com | sh"
  else
    tmp="$(mktemp)"; curl -fsSL https://get.docker.com -o "$tmp"; sh "$tmp"; rm -f "$tmp"
  fi
fi
run systemctl enable --now docker

# ── 3. swap ──────────────────────────────────────────────────
log "Swap"
if [ "$SWAP" = 0 ]; then
  ok "skipped (--swap 0)"
elif [ "$(swapon --show --noheadings 2>/dev/null | wc -l)" -gt 0 ]; then
  ok "swap already active"
else
  run fallocate -l "$SWAP" /swapfile
  run chmod 600 /swapfile
  run mkswap /swapfile
  run swapon /swapfile
  if ! grep -q '^/swapfile ' /etc/fstab 2>/dev/null; then
    [ "$DRY" = 1 ] && echo "    [dry-run] append /swapfile to /etc/fstab" \
      || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
  ok "swap $SWAP created"
fi

# ── 4. firewall ──────────────────────────────────────────────
log "Firewall (ufw)"
# SSH first, so enabling the firewall cannot lock you out.
run ufw default deny incoming
run ufw default allow outgoing
run ufw allow 22/tcp
run ufw allow 80/tcp
run ufw allow 443/tcp
run ufw --force enable
ok "22, 80, 443 open. Postgres is on the internal network, n8n on 127.0.0.1"

# ── 5. .env ──────────────────────────────────────────────────
log ".env"
if [ ! -f "$ENV_FILE" ]; then
  run cp "$ROOT/.env.example" "$ENV_FILE"
  run chmod 600 "$ENV_FILE"
  ok "created from .env.example"
else
  run chmod 600 "$ENV_FILE"
  ok ".env exists, kept"
fi

# set_env KEY VALUE: replace an existing KEY= line (non-secret values only)
set_env() {
  local key="$1" val="$2" tmp
  if [ "$DRY" = 1 ]; then echo "    [dry-run] set $key"; return; fi
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
}
set_env N8N_HOST "$DOMAIN"
set_env N8N_PROTOCOL https
set_env WEBHOOK_URL "https://$DOMAIN/"
ok "N8N_HOST / N8N_PROTOCOL / WEBHOOK_URL set for $DOMAIN"

if [ "$DRY" = 1 ]; then
  echo "    [dry-run] scripts/gen-secrets.sh"
else
  # Refuses to overwrite secrets when a data volume already exists.
  bash "$ROOT/scripts/gen-secrets.sh" || warn "gen-secrets.sh reported a problem (see above)"
fi

# ── 6. DNS check ─────────────────────────────────────────────
log "DNS"
resolved="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')" || true
mine="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src") print $(i+1)}')" || true
if [ -z "$resolved" ]; then
  warn "$DOMAIN does not resolve yet. Caddy cannot get a certificate until it points at this server (${mine:-unknown IP})"
elif [ -n "$mine" ] && [ "$resolved" != "$mine" ]; then
  warn "$DOMAIN -> $resolved but this server is $mine (ignore if behind a proxy/NAT)"
else
  ok "$DOMAIN -> $resolved"
fi

# ── 7. start ─────────────────────────────────────────────────
log "Next steps"
missing=""
if [ "$DRY" = 0 ]; then
  for k in TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
    v="$(grep -E "^$k=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-)"
    case "$v" in ""|*your-bot-token*|123456789*) missing="$missing $k" ;; esac
  done
fi
if [ -n "$missing" ]; then
  warn "fill in$missing in $ENV_FILE (nano .env)"
fi

if [ "$START" = 1 ]; then
  if [ -n "$missing" ]; then
    warn "not starting: .env incomplete"
  else
    run docker compose --project-directory "$ROOT" --profile cloud up -d --build
    ok "stack started. Check with: scripts/stack-health.sh"
  fi
else
  echo "    1. nano .env           # TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID"
  echo "    2. scripts/check-env.sh"
  echo "    3. docker compose --profile cloud up -d --build"
  echo "    4. scripts/stack-health.sh"
  echo "    5. Back up N8N_ENCRYPTION_KEY somewhere other than this server"
fi

[ "$WARN" = 0 ] && echo && echo "bootstrap finished without warnings" \
  || { echo; echo "bootstrap finished with warnings (see WARN lines)"; }
