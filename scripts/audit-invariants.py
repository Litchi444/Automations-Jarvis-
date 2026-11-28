#!/usr/bin/env python3
"""Mechanical audit of the Jarvis design invariants on the GENERATED workflows.

Agents run this instead of reading workflows/*.json (~58 KB). One line per check.
Exit 0 = all PASS. Usage: python3 scripts/audit-invariants.py [workflows_dir]
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
WF_DIR = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "workflows"
failed = 0


def report(name, ok, detail=""):
    global failed
    failed += not ok
    print(f"{name + ':':<52} {'PASS' if ok else 'FAIL'}{(' (' + detail + ')') if detail else ''}")


def load(fname):
    return json.loads((WF_DIR / fname).read_text(encoding="utf-8"))


def by_name(wf):
    return {n["name"]: n for n in wf["nodes"]}


def edges(wf, kind="main"):
    """Yield (source, output_index, target) for one connection kind."""
    for src, kinds in wf["connections"].items():
        for i, outs in enumerate(kinds.get(kind, [])):
            for e in outs or []:
                yield src, i, e["node"]


asst = load("workflow_assistant.json")
speak = load("workflow_speak.json")
brief = load("workflow_morning_briefing.json")
uni = load("workflow_university_mail.json")
ALL = (asst, speak, brief, uni)
A = by_name(asst)


def select_only(sql):
    """One fixed SELECT statement, no write keywords, no expression interpolation."""
    body = re.sub(r"--[^\n]*", "", sql).strip().rstrip(";").strip()
    return (body.upper().startswith("SELECT") and ";" not in body and "{{" not in sql
            and not re.search(r"\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|SET)\b",
                              body, re.I))


# 1. Agent tools are read-only ------------------------------------------------
READ_ONLY = {
    "n8n-nodes-base.googleCalendarTool": {"getAll", "get"},
    "n8n-nodes-base.gmailTool": {"getAll", "get"},
    "n8n-nodes-base.googleTasksTool": {"getAll", "get"},
    "n8n-nodes-base.postgresTool": {"executeQuery"},  # + select_only() below
}
tools = [s for s, _, t in edges(asst, "ai_tool")]
bad = [f"{t} ({A[t]['type'].split('.')[-1]}:{A[t]['parameters'].get('operation')})"
       for t in tools
       if A[t]["type"] not in READ_ONLY or A[t]["parameters"].get("operation") not in READ_ONLY[A[t]["type"]]
       or (A[t]["type"].endswith("postgresTool") and not select_only(A[t]["parameters"].get("query", "")))]
report("agent tools are read-only", bool(tools) and not bad, ", ".join(bad) or f"{len(tools)} tools")

# 2. Nothing else is wired into the agent as a tool/sub-agent with write power
write_like = [n["name"] for n in asst["nodes"]
              if n["type"].endswith("Tool") and n["name"] not in tools]
report("no unconnected/extra tool nodes", not write_like, ", ".join(write_like))

# 3. Writes to the outside world only exist behind a gate ---------------------
#    Card gate: "Approved?" output 0 (a human tap, claimed atomically). Instant gate:
#    "Card or instant?" instant output (task add / done the user's own words asked for).
#    Undo gate: "Undo?" output 0 (a human tap, claimed atomically).
sys.path.insert(0, str(ROOT / "src"))
import build_workflows  # noqa: E402  (module import has no side effects)

WRITE_OPS = {"create", "update", "delete", "send", "reply", "addLabels", "removeLabels", "markAsRead", "markAsUnread"}
WRITER_TYPES = ("n8n-nodes-base.googleCalendar", "n8n-nodes-base.gmail", "n8n-nodes-base.googleTasks")
writers = [n["name"] for n in asst["nodes"]
           if n["type"] in WRITER_TYPES and n["parameters"].get("operation") in WRITE_OPS]
GATES = {
    "card": ("Approved?", build_workflows.OUTCOME["execute"]),
    "instant": ("Card or instant?", build_workflows.MODE["instant"]),
    "undo": ("Undo?", build_workflows.UNDO["run"]),
}
gate_edges = {(src, i) for src, i in GATES.values()}
main = list(edges(asst))


def reach(starts):
    seen, todo = set(), list(starts)
    while todo:
        n = todo.pop()
        if n in seen:
            continue
        seen.add(n)
        todo += [t for s_, i, t in main if s_ == n and (s_, i) not in gate_edges]
    return seen


ungated = sorted(set(writers) & reach(["Telegram Trigger"]))
report("writes only behind a gate (card/instant/undo)", bool(writers) and not ungated,
       ", ".join(ungated) or f"{len(writers)} write node(s) gated")
behind = {g: set(writers) & reach([t for s_, i, t in main if (s_, i) == GATES[g]]) for g in GATES}
op = lambda w: (A[w]["type"].split(".")[-1], A[w]["parameters"].get("operation"))  # noqa: E731
bad_instant = [w for w in behind["instant"] if op(w) not in {("googleTasks", "create"), ("googleTasks", "update")}]
report("instant gate: only task add / status change", bool(behind["instant"]) and not bad_instant,
       ", ".join(bad_instant) or ", ".join(sorted(behind["instant"])))
bad_undo = [w for w in behind["undo"] if A[w]["type"] != "n8n-nodes-base.googleTasks"]
report("undo gate: only Google Tasks", bool(behind["undo"]) and not bad_undo, ", ".join(bad_undo))
inst_sql = A.get("Log instant action", {}).get("parameters", {}).get("query", "")
inst_ok = ("Card or instant?", build_workflows.MODE["instant"], "Log instant action") in set(main) \
    and "IN ('task_add', 'task_done')" in inst_sql and "instant" in inst_sql
report("instant actions logged first, task kinds only", inst_ok)
mode_src = A.get("One item per proposal", {}).get("parameters", {}).get("jsCode", "")
report("instant mode only for task_add / task_done",
       "INSTANT_KINDS = ['task_add', 'task_done']" in mode_src and "x.instant === true" in mode_src)

# 4. Approval chain: Approved? is fed by the atomic claim; Undo? by the atomic undo claim --
chain_ok = ("Claim decision", 0, "Decision outcome") in set(main) and \
           ("Decision outcome", 0, "Approved?") in set(main) and \
           "UPDATE assistant.proposals" in A.get("Claim decision", {}).get("parameters", {}).get("query", "") and \
           "status = 'pending'" in A["Claim decision"]["parameters"]["query"]
report("approval goes through atomic claim_decision", chain_ok)
undo_q = A.get("Claim undo", {}).get("parameters", {}).get("query", "")
undo_ok = ("Claim undo", 0, "Undo outcome") in set(main) and ("Undo outcome", 0, "Undo?") in set(main) \
    and "status = 'executed' AND instant" in undo_q and "interval '24 hours'" in undo_q
report("undo goes through atomic claim_undo (24 h, instant only)", undo_ok)
delete_checked = all(any((g, 0, c) in set(main) for g, c in (("Get event", "Check event"), ("Get task", "Check task")))
                     and w in reach(["Check event", "Check task"])
                     for w in writers if A[w]["parameters"].get("operation") in ("delete", "update")
                     and w in behind["card"])
report("card move/done/delete re-check the target first", delete_checked)

# 5. Write payload comes from the stored row, not the agent ---------------------
AGENT_REFS = ("$fromAI", "$('Jarvis')", "$('Parse + validate')", "$('Prepare agent input')")
not_stored = [w for w in writers
              if not re.search(r"\$json\.(payload|result)\.", json.dumps(A[w]["parameters"]))
              or any(r in json.dumps(A[w]["parameters"]) for r in AGENT_REFS)]
report("writes use the STORED payload / result", bool(writers) and not not_stored, ", ".join(not_stored))

# 6. No invitations / emails to third parties ----------------------------------
SEND_UPDATES = {"create": "additionalFields", "update": "updateFields", "delete": "options"}
cal_writers = [A[w] for w in writers if A[w]["type"] == "n8n-nodes-base.googleCalendar"]
inv = [c["name"] for c in cal_writers
       if c["parameters"].get("additionalFields", {}).get("attendees")
       or c["parameters"].get("updateFields", {}).get("attendees")
       or c["parameters"].get(SEND_UPDATES.get(c["parameters"]["operation"], ""), {}).get("sendUpdates") != "none"]
report("no attendees, sendUpdates=none", bool(cal_writers) and not inv, ", ".join(inv))
primary_only = [c["name"] for c in cal_writers + [A[n] for n in A if A[n]["type"] == "n8n-nodes-base.googleCalendar"]
                if c["parameters"].get("calendar", {}).get("value") != "primary"]
report("calendar writes on the primary calendar only", not primary_only, ", ".join(primary_only))
gmail_writes = [n["name"] for wf in ALL for n in wf["nodes"]
                if "gmail" in n["type"].lower() and n["parameters"].get("operation") in WRITE_OPS]
report("no Gmail write operations anywhere", not gmail_writes, ", ".join(gmail_writes))

# 7. SQL is parameterized -------------------------------------------------------
pg = [n for wf in ALL for n in wf["nodes"] if n["type"] in ("n8n-nodes-base.postgres", "n8n-nodes-base.postgresTool")]
interp = [n["name"] for n in pg if "{{" in n["parameters"].get("query", "") or n["parameters"].get("query", "").startswith("=")]
noparams = [n["name"] for n in pg if "$1" in n["parameters"].get("query", "")
            and not str(n["parameters"].get("options", {}).get("queryReplacement", "")).startswith("={{ [")]
report("SQL parameterized (no interpolation)", bool(pg) and not interp and not noparams,
       ", ".join(interp + noparams) or f"{len(pg)} queries")

# 8. Telegram trigger: chat filter + callbacks, version >= 1.4 ------------------
trig = [n for n in asst["nodes"] if n["type"] == "n8n-nodes-base.telegramTrigger"]
t_ok = len(trig) == 1 and trig[0]["typeVersion"] >= 1.4 and \
       "callback_query" in trig[0]["parameters"].get("updates", []) and \
       trig[0]["parameters"].get("additionalFields", {}).get("chatIds")
report("telegram trigger: chat filter, taps, v>=1.4", bool(t_ok),
       f"v{trig[0]['typeVersion']}" if trig else "missing")
route_src = A.get("Route update", {}).get("parameters", {}).get("jsCode", "")
report("second chat-id gate in 'Route update'", "TELEGRAM_CHAT_ID" in route_src and "return []" in route_src)

# 9. Generated JSON in sync with the generator (full in-memory rebuild) ----------
stale = [f for f, w in build_workflows.build_all().items()
         if not (WF_DIR / f).exists()
         or (WF_DIR / f).read_text(encoding="utf-8").replace("\r\n", "\n") != w.to_json()]
report("workflows in sync with generator (regenerated)", not stale, ", ".join(stale))

# 10. No secrets committed into workflows ---------------------------------------
blob = "\n".join(json.dumps(w) for w in ALL)
secrets = re.findall(r"\d{6,}:[A-Za-z0-9_-]{30,}|AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9]{20,}", blob)
report("no secrets in workflow JSON", not secrets, f"{len(secrets)} found" if secrets else "")

# 11. Cross-workflow references ---------------------------------------------------
ids = {w["id"] for w in ALL}
calls = [n["parameters"]["workflowId"]["value"] for w in (asst, brief) for n in w["nodes"]
         if n["type"] == "n8n-nodes-base.executeWorkflow"]
report("sub-workflow calls resolve", bool(calls) and all(c in ids for c in calls), ", ".join(sorted(set(calls))))

# 12. University mailbox is only read, and its copy only feeds the database --------
imap = [n for n in uni["nodes"] if n["type"] == "n8n-nodes-base.emailReadImap"]
imap_ok = len(imap) == 1 and imap[0]["parameters"].get("postProcessAction") == "nothing" \
    and not imap[0]["parameters"].get("downloadAttachments")
report("IMAP trigger leaves the mailbox untouched", imap_ok,
       imap[0]["parameters"].get("postProcessAction", "default=read") if imap else "missing")
UNI_ALLOWED = {"n8n-nodes-base.emailReadImap", "n8n-nodes-base.code", "n8n-nodes-base.postgres"}
extra = [n["name"] for n in uni["nodes"] if n["type"] not in UNI_ALLOWED]
report("uni mail workflow: IMAP -> code -> postgres only", not extra, ", ".join(extra))

# 13. Writing skills: generated SQL matches skills/*.md, and the agent only reads them ---
expected, n_skills = build_workflows.skills_sql()
on_disk = build_workflows.SKILLS_SQL.read_text(encoding="utf-8").replace("\r\n", "\n") \
    if build_workflows.SKILLS_SQL.exists() else ""
report("02-skills.sql in sync with skills/ (regenerated)", on_disk == expected, f"{n_skills} skill(s)")
skill_tools = [t for t in tools if "assistant.skills" in A[t]["parameters"].get("query", "")]
report("skills reachable only via read-only agent tools", len(skill_tools) == 2,
       ", ".join(skill_tools) or "missing")

# 14. Answer styles: generated SQL in sync, the setting is written only by the /style command --
expected, n_styles = build_workflows.styles_sql()
on_disk = build_workflows.STYLES_SQL.read_text(encoding="utf-8").replace("\r\n", "\n") \
    if build_workflows.STYLES_SQL.exists() else ""
report("03-styles.sql in sync with styles/ (regenerated)", on_disk == expected, f"{n_styles} style(s)")
style_tools = [t for t in tools if re.search(r"assistant\.(styles|chat_settings)", A[t]["parameters"].get("query", ""))]
report("agent has no tool on styles / chat_settings", not style_tools, ", ".join(style_tools))
setting_writers = [n["name"] for wf in ALL for n in wf["nodes"]
                   if "chat_settings" in n["parameters"].get("query", "")
                   and re.search(r"\b(INSERT|UPDATE|DELETE)\b", n["parameters"].get("query", ""), re.I)]
style_route = build_workflows.ROUTE["style"]
fed_by_route = {t for s, i, t in edges(asst) if s == "Route" and i == style_route}
report("style setting written only from Route 'style' output",
       setting_writers == ["Set style"] and fed_by_route == {"Set style"}
       and all(s == "Route" for s, _, t in edges(asst) if t == "Set style"),
       ", ".join(setting_writers) or "no writer")

sys.exit(1 if failed else 0)
