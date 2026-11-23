#!/usr/bin/env bash
# Approval-card audit: counts by status, last 10 decisions, stuck approvals.
source "$(dirname "$0")/_lib.sh"

q() {
  docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -F " | " -c "$1"' sh "$1" 2>&1 | head -n 15
}

echo "status counts:"
q "select status, count(*) from assistant.proposals group by status order by status" | sed 's/^/  /'
echo "last 10 (id | status | created | decided | card title):"
q "select id, status, to_char(created_at,'MM-DD HH24:MI'), coalesce(to_char(decided_at,'HH24:MI'),'-'), left(split_part(summary, chr(10), 1), 40) from assistant.decision_log limit 10" | sed 's/^/  /'

stuck="$(q "select count(*) from assistant.proposals where status='approved' and decided_at < now() - interval '10 minutes'" | tr -d '[:space:]')"
if [ "$stuck" = "0" ]; then pass "no stuck approvals"
else fail "no stuck approvals" "$stuck approved >10 min ago but never executed/failed; check the assistant executions"; fi
exit "$FAILED"
