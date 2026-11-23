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
    return json.loads((WF_DIR / fname).read_text())


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
A = by_name(asst)

# 1. Agent tools are read-only ------------------------------------------------
READ_ONLY = {
    "n8n-nodes-base.googleCalendarTool": {"getAll", "get"},
    "n8n-nodes-base.gmailTool": {"getAll", "get"},
}
tools = [s for s, _, t in edges(asst, "ai_tool")]
bad = [f"{t} ({A[t]['type'].split('.')[-1]}:{A[t]['parameters'].get('operation')})"
       for t in tools
       if A[t]["type"] not in READ_ONLY or A[t]["parameters"].get("operation") not in READ_ONLY[A[t]["type"]]]
report("agent tools are read-only", bool(tools) and not bad, ", ".join(bad) or f"{len(tools)} tools")

# 2. Nothing else is wired into the agent as a tool/sub-agent with write power
write_like = [n["name"] for n in asst["nodes"]
              if n["type"].endswith("Tool") and n["name"] not in tools]
report("no unconnected/extra tool nodes", not write_like, ", ".join(write_like))

# 3. Writes to the outside world only exist behind the approval switch ---------
WRITE_OPS = {"create", "update", "delete", "send", "reply", "addLabels", "removeLabels", "markAsRead", "markAsUnread"}
writers = [n["name"] for n in asst["nodes"]
           if n["type"] in ("n8n-nodes-base.googleCalendar", "n8n-nodes-base.gmail", "n8n-nodes-base.googleTasks")
           and n["parameters"].get("operation") in WRITE_OPS]
gated = {t for s, i, t in edges(asst) if s == "Approved?" and i == 0}
ungated = [w for w in writers if w not in gated]
report("writes only after 'Approved?' output 0", not ungated, ", ".join(ungated) or f"{len(writers)} write node(s) gated")

# 4. Approval chain: Approved? is fed by the atomic claim ----------------------
chain_ok = ("Claim decision", 0, "Decision outcome") in set(edges(asst)) and \
           ("Decision outcome", 0, "Approved?") in set(edges(asst)) and \
           "UPDATE assistant.proposals" in A.get("Claim decision", {}).get("parameters", {}).get("query", "") and \
           "status = 'pending'" in A["Claim decision"]["parameters"]["query"]
report("approval goes through atomic claim_decision", chain_ok)

# 5. Write payload comes from the stored row, not the agent ---------------------
create = [A[w] for w in writers if A[w]["parameters"].get("operation") == "create"]
AGENT_REFS = ("$fromAI", "$('Jarvis')", "$('Parse + validate')", "$('Prepare agent input')")
uses_stored = all("$json.payload." in json.dumps(c["parameters"])
                  and not any(r in json.dumps(c["parameters"]) for r in AGENT_REFS) for c in create)
report("created items use the STORED payload", bool(create) and uses_stored)

# 6. No invitations / emails to third parties ----------------------------------
inv = [c["name"] for c in create
       if c["parameters"].get("additionalFields", {}).get("attendees")
       or c["parameters"].get("additionalFields", {}).get("sendUpdates") not in ("none",)]
report("no attendees, sendUpdates=none", not inv, ", ".join(inv))
gmail_writes = [n["name"] for wf in (asst, speak, brief) for n in wf["nodes"]
                if "gmail" in n["type"].lower() and n["parameters"].get("operation") in WRITE_OPS]
report("no Gmail write operations anywhere", not gmail_writes, ", ".join(gmail_writes))

# 7. SQL is parameterized -------------------------------------------------------
pg = [n for wf in (asst,) for n in wf["nodes"] if n["type"] == "n8n-nodes-base.postgres"]
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

# 9. Generated JSON in sync with src/ -------------------------------------------
srcs = {p.read_text() for p in (ROOT / "src").rglob("*.js")} | {p.read_text() for p in (ROOT / "src").rglob("*.sql")}
stale = [f"{wf['name'][:12]}/{n['name']}" for wf in (asst, speak, brief) for n in wf["nodes"]
         if (n["parameters"].get("jsCode") and n["parameters"]["jsCode"] not in srcs)
         or (n["parameters"].get("operation") == "executeQuery" and n["parameters"]["query"] not in srcs)]
report("workflows in sync with src/ (regenerated)", not stale, ", ".join(stale[:3]))

# 10. No secrets committed into workflows ---------------------------------------
blob = "\n".join(json.dumps(w) for w in (asst, speak, brief))
secrets = re.findall(r"\d{6,}:[A-Za-z0-9_-]{30,}|AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9]{20,}", blob)
report("no secrets in workflow JSON", not secrets, f"{len(secrets)} found" if secrets else "")

# 11. Cross-workflow references ---------------------------------------------------
ids = {w["id"] for w in (asst, speak, brief)}
calls = [n["parameters"]["workflowId"]["value"] for w in (asst, brief) for n in w["nodes"]
         if n["type"] == "n8n-nodes-base.executeWorkflow"]
report("sub-workflow calls resolve", bool(calls) and all(c in ids for c in calls), ", ".join(sorted(set(calls))))

sys.exit(1 if failed else 0)
