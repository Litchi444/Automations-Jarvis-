#!/usr/bin/env bash
# Telegram webhook status, without ever printing the bot token.
source "$(dirname "$0")/_lib.sh"

token="$(env_get TELEGRAM_BOT_TOKEN)"
[ -n "$token" ] || { fail "telegram token" "TELEGRAM_BOT_TOKEN missing in .env"; exit 1; }

json="$(curl -sS -m 10 "https://api.telegram.org/bot${token}/getWebhookInfo" 2>&1 | sed "s/${token}/<token>/g")"
WEBHOOK_URL="$(env_get WEBHOOK_URL)" JSON="$json" python3 - <<'PY'
import json, os, time, sys
from urllib.parse import urlparse
fails = 0
def line(k, v): print(f"{k + ':':<34} {v}")
try:
    d = json.loads(os.environ["JSON"])
except Exception:
    line("telegram api", "FAIL (" + os.environ["JSON"][:150] + ")"); sys.exit(1)
if not d.get("ok"):
    line("telegram api", f"FAIL ({d.get('description', 'unknown')})"); sys.exit(1)
r = d["result"]
url = r.get("url") or ""
want = urlparse(os.environ.get("WEBHOOK_URL", "")).hostname
if not url:
    line("webhook url", "FAIL (none: publish the Assistant workflow and restart n8n)"); fails += 1
else:
    host = urlparse(url).hostname
    line("webhook url", f"set ({host}{urlparse(url).path[:40]}…)")
    ok = host == want
    line("webhook host matches WEBHOOK_URL", "PASS" if ok else f"FAIL (telegram has {host}, .env has {want})"); fails += (not ok)
au = r.get("allowed_updates") or []
ok = (not au) or ("callback_query" in au)
line("button taps delivered", "PASS" if ok else f"FAIL (allowed_updates={au})"); fails += (not ok)
line("pending updates", str(r.get("pending_update_count", 0)))
err = r.get("last_error_message")
if err:
    age = int((time.time() - r.get("last_error_date", time.time())) / 60)
    line("webhook last_error", f"{err[:120]} ({age} min ago)")
else:
    line("webhook last_error", "none")
sys.exit(1 if fails else 0)
PY
