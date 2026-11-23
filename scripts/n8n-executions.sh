#!/usr/bin/env bash
# Last N executions, one line each: id, workflow, status, time, last node, error.
# Needs N8N_API_KEY in .env (n8n Settings → n8n API). Skips cleanly without it.
# Execution data can hold MBs of base64 audio: it is parsed here, never printed.
source "$(dirname "$0")/_lib.sh"
n="${1:-10}"
key="$(env_get N8N_API_KEY)"
[ -n "$key" ] || { skip "executions" "set N8N_API_KEY in .env (plan/H1 step 4)"; exit 0; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -sS -m 30 -H "X-N8N-API-KEY: ${key}" \
  "http://127.0.0.1:5678/api/v1/executions?limit=${n}&includeData=true" >"$tmp" 2>&1

RAW_FILE="$tmp" python3 - <<'PY'
import json, os, sys
names = {"mbSpeakVoiceNote": "speak", "mbMorningBrief01": "briefing", "mbAssistant00001": "assistant"}
raw = open(os.environ["RAW_FILE"], encoding="utf-8", errors="replace").read()
try:
    d = json.loads(raw)
except Exception:
    print("executions: FAIL (" + raw[:150].replace("\n", " ") + ")")
    sys.exit(1)
rows = d.get("data", [])
if not rows:
    print("executions: none yet")
    sys.exit(0)
bad = 0
for e in rows:
    data = e.get("data") or {}
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except Exception:
            data = {}
    rd = data.get("resultData", {}) if isinstance(data, dict) else {}
    err = rd.get("error") or {}
    msg = (err.get("message") if isinstance(err, dict) else str(err)) or ""
    status = e.get("status", "?")
    bad += status not in ("success", "running", "waiting")
    wid = e.get("workflowId", "?")
    started = (e.get("startedAt") or "")[5:16].replace("T", " ")
    last = str(rd.get("lastNodeExecuted", "-"))[:24]
    print(f"{str(e.get('id')):>6} {names.get(wid, wid):<10} {status:<8} {started}  last={last:<24} {msg[:90]}")
print(f"executions with errors: {bad}/{len(rows)}")
sys.exit(1 if bad else 0)
PY
