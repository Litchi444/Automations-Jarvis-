#!/usr/bin/env bash
# One-screen health report of the running stack. Exit 0 = healthy.
source "$(dirname "$0")/_lib.sh"

docker compose ps --format '{{.Service}}: {{.State}} {{.Health}}' 2>/dev/null | sed 's/^/container /' | head -n 5

# n8n can take a while on first boot (DB migrations): wait up to ~90 s
ok=""
for _ in $(seq 1 30); do
  if curl -fsS -m 3 http://127.0.0.1:5678/healthz >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
[ -n "$ok" ] && pass "n8n healthz" || fail "n8n healthz" "no answer on 127.0.0.1:5678 after 90 s; check: docker compose logs --tail=60 n8n"

nx() { docker compose exec -T n8n "$@" 2>/dev/null; }

if nx /usr/local/bin/ffmpeg -hide_banner -encoders | grep -q libopus; then pass "ffmpeg libopus"
else fail "ffmpeg libopus" "ffmpeg missing or built without Opus"; fi

if nx node -e "require('fs').accessSync('/home/node/.n8n-files', require('fs').constants.W_OK)"; then pass "/home/node/.n8n-files writable"
else fail "/home/node/.n8n-files writable" "chown -R node:node via: docker compose exec -u root n8n ..."; fi

if nx node -e "const x=process.env.NODES_EXCLUDE||'';process.exit(x&&!x.includes('executeCommand')?0:1)"; then pass "Execute Command enabled"
else fail "Execute Command enabled" "NODES_EXCLUDE not applied; docker compose up -d --force-recreate n8n"; fi

if nx node -e "process.exit(process.env.N8N_BLOCK_ENV_ACCESS_IN_NODE==='false'?0:1)"; then pass "\$env access in expressions"
else fail "\$env access in expressions" "N8N_BLOCK_ENV_ACCESS_IN_NODE must be false"; fi

schema="$(docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select to_regclass('"'"'assistant.proposals'"'"') is not null"' 2>/dev/null | tr -d '[:space:]')"
if [ "$schema" = "t" ]; then pass "schema assistant.proposals"
else fail "schema assistant.proposals" "MISSING: apply docker/postgres/init/01-assistant.sql (see plan/P2)"; fi

if [ "$(env_get N8N_PROTOCOL)" = "https" ]; then
  docker compose ps --status running --format '{{.Service}}' 2>/dev/null | grep -qx caddy \
    && pass "caddy running" || fail "caddy running" "start with --profile cloud"
fi
exit "$FAILED"
