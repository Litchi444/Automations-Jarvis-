"""Generates the four n8n workflow exports in workflows/ from the sources in src/,
docker/postgres/init/02-skills.sql from skills/*.md and 03-styles.sql from styles/*.md.

    python3 src/build_workflows.py

Never hand-edit jsCode / SQL inside the JSON: edit src/ and regenerate.
"""
import itertools
import json
import pathlib
import re
import uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
OUT = ROOT / "workflows"

# Fixed 16-char IDs so workflows can reference each other after import.
SPEAK_ID = "mbSpeakVoiceNote"
BRIEFING_ID = "mbMorningBrief01"
ASSISTANT_ID = "mbAssistant00001"
UNIMAIL_ID = "mbUniMailIngest1"

FILES_DIR = "/home/node/.n8n-files"
# flash-lite: on the free tier gemini-flash-latest often returns 503 (high
# demand) and has a 5 req/min cap; one agent turn makes several calls.
TEXT_MODEL = "gemini-flash-lite-latest"
GEMINI_BASE ="https://generativelanguage.googleapis.com/v1beta/models/"
TG = "https://api.telegram.org/bot{{ $env.TELEGRAM_BOT_TOKEN }}"
GEMINI_AUTH = {"authentication": "genericCredentialType", "genericAuthType": "httpHeaderAuth"}
PRIMARY_CAL = {"__rl": True, "mode": "list", "value": "primary", "cachedResultName": "Primary calendar"}
# Switch output indices. The Code node that feeds each Switch must declare the
# identical JS constant (checked by code()), so JS and wiring cannot drift.
ROUTE = {"voice": 0, "text": 1, "callback": 2, "style": 3}  # "Route update" -> "Route"
REPLY = {"voice": 0, "text": 1}                  # "Parse + validate" -> "Voice or text?"
OUTCOME = {"create": 0, "cardOnly": 1}           # "Decision outcome" -> "Approved?" (0 = write gate, audited)


def read(rel: str) -> str:
    return (SRC / rel).read_text(encoding="utf-8")


NODE_REF = re.compile(r"\$\('([^']+)'\)")


def node_refs(value):
    """Every $('Name') used anywhere in a node's parameters (code and expressions)."""
    if isinstance(value, dict):
        return {r for v in value.values() for r in node_refs(v)}
    if isinstance(value, list):
        return {r for v in value for r in node_refs(v)}
    return set(NODE_REF.findall(value)) if isinstance(value, str) else set()


class WF:
    def __init__(self, wid: str, name: str):
        self.wid, self.name = wid, name
        self.nodes, self.connections = [], {}

    def node(self, name, type_, version, pos, params, **extra):
        n = {"parameters": params,
             "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"{self.wid}/{name}")),
             "name": name, "type": type_, "typeVersion": version, "position": pos}
        n.update(extra)
        self.nodes.append(n)
        return name

    def link(self, src, dst, out=0, kind="main"):
        outs = self.connections.setdefault(src, {}).setdefault(kind, [])
        while len(outs) <= out:
            outs.append([])
        outs[out].append({"node": dst, "type": kind, "index": 0})

    def chain(self, *names):
        for a, b in itertools.pairwise(names):
            self.link(a, b)

    def to_json(self) -> str:
        """Validates the workflow and returns the exported JSON text. Writes nothing."""
        names = {n["name"] for n in self.nodes}
        assert len(names) == len(self.nodes), "duplicate node names"
        for src, kinds in self.connections.items():
            assert src in names, f"{self.name}: unknown source {src}"
            for outs in kinds.values():
                for edges in outs:
                    for e in edges:
                        assert e["node"] in names, f"{self.name}: unknown target {e['node']}"
        for n in self.nodes:
            for ref in node_refs(n["parameters"]):
                assert ref in names, f"{self.name}: node '{n['name']}' references unknown node $('{ref}')"
        wf = {
            "id": self.wid, "name": self.name, "nodes": self.nodes,
            "connections": self.connections, "active": False,
            "settings": {"executionOrder": "v1", "saveDataSuccessExecution": "all",
                         "saveDataErrorExecution": "all", "callerPolicy": "workflowsFromSameOwner"},
            "pinData": {}, "meta": {"templateCredsSetupCompleted": False}, "tags": [],
        }
        return json.dumps(wf, indent=2, ensure_ascii=False) + "\n"

    def write(self, filename):
        (OUT / filename).write_text(self.to_json(), encoding="utf-8", newline="\n")
        print(f"wrote workflows/{filename}: {len(self.nodes)} nodes")


def assign(name, value, type_="string"):
    return {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, "cfg/" + name)), "name": name, "value": value, "type": type_}


def set_node(*assignments):
    return {"mode": "manual", "assignments": {"assignments": list(assignments)}, "options": {}}


def js_const(name, mapping):
    return f"const {name} = {{ " + ", ".join(f"{k}: {v}" for k, v in mapping.items()) + " };"


def code(rel, **consts):
    src = read(rel)
    for name, mapping in consts.items():
        decl = js_const(name, mapping)
        assert decl in src, f"src/{rel}: must declare `{decl}` (generator wiring depends on it)"
    return {"jsCode": src}


def http_json(method, url, body, **opts):
    return {"method": method, "url": url, "sendBody": True, "specifyBody": "json",
            "jsonBody": body, "options": opts or {}}


def pg_query(sql_rel, replacement=None):
    return {"operation": "executeQuery", "query": read(sql_rel),
            "options": {"queryReplacement": replacement} if replacement else {}}


def exec_speak():
    return {"source": "database",
            "workflowId": {"__rl": True, "mode": "id", "value": SPEAK_ID},
            "workflowInputs": {"mappingMode": "defineBelow", "value": {}, "matchingColumns": [],
                               "schema": [], "attemptToConvertTypes": False,
                               "convertFieldsToString": True},
            "mode": "once", "options": {"waitForSubWorkflow": True}}


# ═══════════════════════════════════════════════════════════════════
# 1) SPEAK: shared sub-workflow. Input item: { text, caption?, chatId? }
#    Owns speech cleaning: callers pass plain text, "Speech-safe text" makes it TTS-safe.
# ═══════════════════════════════════════════════════════════════════
def build_speak():
    w = WF(SPEAK_ID, "Speak: text → Gemini voice → Telegram (sub-workflow)")
    cfg = "$('Config').first().json"

    w.node("When called by another workflow", "n8n-nodes-base.executeWorkflowTrigger", 1.1, [-220, 300],
           {"inputSource": "passthrough"})
    w.node("Speech-safe text", "n8n-nodes-base.code", 2, [0, 300], code("speak_sanitize.js"))
    w.node("Config", "n8n-nodes-base.set", 3.4, [220, 300], set_node(
        assign("ttsModel", "gemini-3.1-flash-tts-preview"),
        assign("voiceName", "Kore"),
        assign("ttsStyle", "Read this in a calm, warm, natural voice"),
        assign("text", "={{ String($json.text || '').trim() }}"),
        assign("caption", "={{ String($json.caption || $json.text || '').slice(0, 1024) }}"),
        assign("chatId", "={{ String($json.chatId || $env.TELEGRAM_CHAT_ID) }}"),
        assign("fileBase", "=speak_{{ $execution.id }}"),
    ))
    w.node("Gemini: text-to-speech", "n8n-nodes-base.httpRequest", 4.2, [440, 300], {
        "method": "POST",
        "url": f"={GEMINI_BASE}{{{{ {cfg}.ttsModel }}}}:generateContent",
        **GEMINI_AUTH,
        "sendBody": True, "specifyBody": "json",
        "jsonBody": (
            "={{ JSON.stringify({\n"
            f"  contents: [{{ parts: [{{ text: {cfg}.ttsStyle + ': ' + {cfg}.text }}] }}],\n"
            "  generationConfig: {\n"
            "    responseModalities: ['AUDIO'],\n"
            f"    speechConfig: {{ voiceConfig: {{ prebuiltVoiceConfig: {{ voiceName: {cfg}.voiceName }} }} }}\n"
            "  }\n"
            "}) }}"
        ),
        "options": {"timeout": 120000},
    }, retryOnFail=True, maxTries=2, waitBetweenTries=10000, onError="continueErrorOutput")
    w.node("PCM to WAV", "n8n-nodes-base.code", 2, [660, 200], code("pcm_to_wav.js"))
    w.node("Write WAV", "n8n-nodes-base.readWriteFile", 1, [880, 200], {
        "operation": "write",
        "fileName": f"={FILES_DIR}/{{{{ {cfg}.fileBase }}}}.wav",
        "dataPropertyName": "data", "options": {}})
    w.node("ffmpeg: WAV to OGG Opus", "n8n-nodes-base.executeCommand", 1, [1100, 200], {
        "executeOnce": True,
        "command": (f"=/usr/local/bin/ffmpeg -hide_banner -loglevel error -y "
                    f"-i {FILES_DIR}/{{{{ {cfg}.fileBase }}}}.wav "
                    f"-ac 1 -ar 48000 -c:a libopus -b:a 32k -application voip "
                    f"{FILES_DIR}/{{{{ {cfg}.fileBase }}}}.ogg"),
    }, onError="continueErrorOutput")
    w.node("Read OGG", "n8n-nodes-base.readWriteFile", 1, [1320, 200], {
        "operation": "read",
        "fileSelector": f"={FILES_DIR}/{{{{ {cfg}.fileBase }}}}.ogg",
        "options": {"dataPropertyName": "data", "mimeType": "audio/ogg"}})
    w.node("Telegram: sendVoice", "n8n-nodes-base.httpRequest", 4.2, [1540, 200], {
        "method": "POST", "url": f"={TG}/sendVoice",
        "sendBody": True, "contentType": "multipart-form-data",
        "bodyParameters": {"parameters": [
            {"name": "chat_id", "value": f"={{{{ {cfg}.chatId }}}}"},
            {"parameterType": "formBinaryData", "name": "voice", "inputDataFieldName": "data"},
            {"name": "caption", "value": f"={{{{ {cfg}.caption }}}}"},
        ]},
        "options": {"timeout": 60000},
    }, retryOnFail=True, maxTries=3, waitBetweenTries=5000)
    w.node("Clean up temp files", "n8n-nodes-base.executeCommand", 1, [1760, 200], {
        "executeOnce": True,
        "command": (f"=rm -f {FILES_DIR}/{{{{ {cfg}.fileBase }}}}.wav "
                    f"{FILES_DIR}/{{{{ {cfg}.fileBase }}}}.ogg"),
    }, onError="continueRegularOutput")
    w.node("Telegram: text fallback", "n8n-nodes-base.httpRequest", 4.2, [1100, 460], http_json(
        "POST", f"={TG}/sendMessage",
        "={{ JSON.stringify({\n"
        f"  chat_id: {cfg}.chatId,\n"
        f"  text: {cfg}.text\n"
        "}) }}"), executeOnce=True)

    w.chain("When called by another workflow", "Speech-safe text", "Config", "Gemini: text-to-speech")
    w.link("Gemini: text-to-speech", "PCM to WAV", 0)
    w.link("Gemini: text-to-speech", "Telegram: text fallback", 1)
    w.chain("PCM to WAV", "Write WAV", "ffmpeg: WAV to OGG Opus")
    w.link("ffmpeg: WAV to OGG Opus", "Read OGG", 0)
    w.link("ffmpeg: WAV to OGG Opus", "Telegram: text fallback", 1)
    w.chain("Read OGG", "Telegram: sendVoice", "Clean up temp files")
    return "workflow_speak.json", w


# ═══════════════════════════════════════════════════════════════════
# 2) MORNING BRIEFING
# ═══════════════════════════════════════════════════════════════════
def build_briefing():
    w = WF(BRIEFING_ID, "Morning Briefing (Gmail + Calendar → voice note)")
    w.node("Every day 07:30", "n8n-nodes-base.scheduleTrigger", 1.2, [0, 300], {
        "rule": {"interval": [{"field": "days", "daysInterval": 1,
                               "triggerAtHour": 7, "triggerAtMinute": 30}]}})
    w.node("Config", "n8n-nodes-base.set", 3.4, [220, 300], set_node(
        assign("textModel", TEXT_MODEL),
        assign("language", "English"),
        assign("maxChars", 300, "number"),
        assign("timezone", "={{ $env.GENERIC_TIMEZONE || 'Europe/Paris' }}"),
    ))
    w.node("Get today events", "n8n-nodes-base.googleCalendar", 1.3, [440, 300], {
        "resource": "event", "operation": "getAll", "calendar": PRIMARY_CAL, "returnAll": True,
        "timeMin": "={{ $today.toISO() }}",
        "timeMax": "={{ $today.plus({ days: 1 }).toISO() }}",
        "options": {"orderBy": "startTime"},
    }, alwaysOutputData=True, executeOnce=True)
    w.node("Get priority emails", "n8n-nodes-base.gmail", 2.1, [660, 300], {
        "resource": "message", "operation": "getAll", "returnAll": False, "limit": 8, "simple": True,
        "filters": {"q": "is:important newer_than:1d -category:promotions -category:social",
                    "readStatus": "unread"},
        "options": {},
    }, alwaysOutputData=True, executeOnce=True)
    # Filled by the "University mail → database" workflow. Never blocks the briefing.
    w.node("Get uni emails", "n8n-nodes-base.postgres", 2.6, [770, 300],
           pg_query("assistant/sql/recent_uni_emails.sql"),
           alwaysOutputData=True, executeOnce=True, onError="continueRegularOutput")
    w.node("Build Gemini prompt", "n8n-nodes-base.code", 2, [880, 300], code("build_prompt.js"))
    w.node("Gemini: write script", "n8n-nodes-base.httpRequest", 4.2, [1100, 300], {
        **http_json("POST",
                    f"={GEMINI_BASE}{{{{ $('Config').first().json.textModel }}}}:generateContent",
                    "={{ JSON.stringify($json.geminiRequest) }}", timeout=60000),
        **GEMINI_AUTH,
    }, retryOnFail=True, maxTries=3, waitBetweenTries=5000)
    w.node("Clean script", "n8n-nodes-base.code", 2, [1320, 300], code("clean_script.js"))
    w.node("Speak", "n8n-nodes-base.executeWorkflow", 1.2, [1540, 300], exec_speak())
    w.chain("Every day 07:30", "Config", "Get today events", "Get priority emails",
            "Get uni emails", "Build Gemini prompt", "Gemini: write script", "Clean script", "Speak")
    return "workflow_morning_briefing.json", w


# ═══════════════════════════════════════════════════════════════════
# 3) ASSISTANT ("Jarvis")
# ═══════════════════════════════════════════════════════════════════
def build_assistant():
    w = WF(ASSISTANT_ID, "Assistant (Jarvis): Telegram voice/text agent with approval cards")
    route = "$('Route update').first().json"
    cfg = "$('Config').first().json"

    # ── Entry ───────────────────────────────────────────────
    w.node("Telegram Trigger", "n8n-nodes-base.telegramTrigger", 1.5, [0, 400], {
        "updates": ["message", "callback_query"],
        "additionalFields": {"chatIds": "={{ $env.TELEGRAM_CHAT_ID }}"},
    }, webhookId=str(uuid.uuid5(uuid.NAMESPACE_URL, "assistant/telegram-webhook")))
    w.node("Config", "n8n-nodes-base.set", 3.4, [200, 400], set_node(
        assign("transcribeModel", TEXT_MODEL),
        assign("proposalTtlHours", 12, "number"),
    ))
    w.node("Route update", "n8n-nodes-base.code", 2, [400, 400], code("assistant/route_update.js", ROUTE=ROUTE))
    w.node("Route", "n8n-nodes-base.switch", 3.2, [600, 400], {
        "mode": "expression", "numberOutputs": len(ROUTE), "output": "={{ $json.route }}"})

    # ── Typing indicator (runs first: higher on canvas) ─────
    w.node("Show typing", "n8n-nodes-base.httpRequest", 4.2, [820, 60], http_json(
        "POST", f"={TG}/sendChatAction",
        "={{ JSON.stringify({ chat_id: $json.chatId, "
        "action: $json.kind === 'voice' ? 'record_voice' : 'typing' }) }}"),
        onError="continueRegularOutput")

    # ── Voice in ────────────────────────────────────────────
    w.node("Get voice file path", "n8n-nodes-base.httpRequest", 4.2, [820, 200], {
        "method": "GET",
        "url": f"={TG}/getFile?file_id={{{{ encodeURIComponent($json.fileId) }}}}",
        "options": {}})
    w.node("Download voice", "n8n-nodes-base.httpRequest", 4.2, [1040, 200], {
        "method": "GET",
        "url": ("=https://api.telegram.org/file/bot{{ $env.TELEGRAM_BOT_TOKEN }}/"
                "{{ $json.result.file_path }}"),
        "options": {"response": {"response": {"responseFormat": "file", "outputPropertyName": "data"}}}})
    w.node("Audio to base64", "n8n-nodes-base.extractFromFile", 1.1, [1260, 200], {
        "operation": "binaryToPropery", "binaryPropertyName": "data",
        "destinationKey": "audioB64", "options": {}})
    w.node("Gemini: transcribe", "n8n-nodes-base.httpRequest", 4.2, [1480, 200], {
        **http_json("POST",
                    f"={GEMINI_BASE}{{{{ {cfg}.transcribeModel }}}}:generateContent",
                    "={{ JSON.stringify({ contents: [{ parts: [\n"
                    "  { text: 'Transcribe this voice message verbatim, in its original language. "
                    "Output only the transcript.' },\n"
                    f"  {{ inlineData: {{ mimeType: {route}.mimeType, data: $json.audioB64 }} }}\n"
                    "] }] }) }}", timeout=60000),
        **GEMINI_AUTH,
    }, retryOnFail=True, maxTries=2, waitBetweenTries=3000)

    # ── Agent ───────────────────────────────────────────────
    # Answer style chosen with /style. Always one row; a failed lookup falls back to the default.
    w.node("Load style", "n8n-nodes-base.postgres", 2.6, [1600, 400], pg_query(
        "assistant/sql/load_style.sql", f"={{{{ [ {route}.chatId ] }}}}"),
        onError="continueRegularOutput")
    w.node("Prepare agent input", "n8n-nodes-base.code", 2, [1760, 400],
           code("assistant/prepare_agent_input.js"))
    w.node("Jarvis", "@n8n/n8n-nodes-langchain.agent", 3.1, [1920, 400], {
        "promptType": "define",
        "text": "={{ $json.userText }}",
        "options": {"systemMessage": "=" + read("assistant/system_message.txt").rstrip("\n"),
                    "maxIterations": 8},
    })
    w.node("Gemini chat model", "@n8n/n8n-nodes-langchain.lmChatGoogleGemini", 1.2, [1760, 640], {
        "modelName": f"models/{TEXT_MODEL}", "options": {}})
    w.node("Chat memory", "@n8n/n8n-nodes-langchain.memoryPostgresChat", 1.4, [1900, 640], {
        "sessionIdType": "customKey",
        "sessionKey": "={{ $('Prepare agent input').first().json.sessionKey }}",
        "tableName": "assistant_chat_history",
        "contextWindowLength": 12})
    w.node("Calendar: list events", "n8n-nodes-base.googleCalendarTool", 1.3, [2040, 640], {
        "descriptionType": "manual",
        "toolDescription": ("Read-only. Lists events in the user's primary Google Calendar between "
                            "two ISO 8601 datetimes (with timezone offset)."),
        "resource": "event", "operation": "getAll", "calendar": PRIMARY_CAL,
        "returnAll": False, "limit": 50,
        "timeMin": "={{ $fromAI('timeMin', 'Range start, ISO 8601 with timezone offset', 'string') }}",
        "timeMax": "={{ $fromAI('timeMax', 'Range end, ISO 8601 with timezone offset', 'string') }}",
        "options": {"orderBy": "startTime"}})
    w.node("Gmail: search", "n8n-nodes-base.gmailTool", 2.1, [2180, 640], {
        "descriptionType": "manual",
        "toolDescription": ("Read-only. Searches Gmail with Gmail search syntax and returns up to 10 "
                            "messages (id, From, Subject, snippet)."),
        "resource": "message", "operation": "getAll", "returnAll": False, "limit": 10, "simple": True,
        "filters": {"q": "={{ $fromAI('query', 'Gmail search query, e.g. from:sara newer_than:7d is:unread', 'string') }}",
                    "readStatus": "both"},
        "options": {}})
    w.node("Gmail: read email", "n8n-nodes-base.gmailTool", 2.1, [2320, 640], {
        "descriptionType": "manual",
        "toolDescription": "Read-only. Returns the full content of one email by its message id (from Gmail: search).",
        "resource": "message", "operation": "get",
        "messageId": "={{ $fromAI('messageId', 'The Gmail message id', 'string') }}",
        "simple": False, "options": {}})
    # Fixed SELECTs; the model only supplies bind values (audited: SELECT-only, parameterized).
    w.node("Uni mail: search", "n8n-nodes-base.postgresTool", 2.6, [2460, 640], {
        "descriptionType": "manual",
        "toolDescription": ("Read-only. Searches the user's university mailbox (univ-lemans.fr). "
                            "Returns up to 10 emails (id, received_at, from_addr, subject, preview), newest first."),
        **pg_query("assistant/sql/search_uni_emails.sql",
                   "={{ [ $fromAI('text', 'Words to find in sender, subject or body. Empty string for all recent emails', 'string'), "
                   "$fromAI('days', 'How many days back to search, 1 to 365', 'number') ] }}")})
    w.node("Uni mail: read email", "n8n-nodes-base.postgresTool", 2.6, [2600, 640], {
        "descriptionType": "manual",
        "toolDescription": "Read-only. Returns the full content of one university email by its id (from Uni mail: search).",
        **pg_query("assistant/sql/read_uni_email.sql",
                   "={{ [ $fromAI('id', 'The university email id', 'number') ] }}")})
    w.node("Skills: list", "n8n-nodes-base.postgresTool", 2.6, [2740, 640], {
        "descriptionType": "manual",
        "toolDescription": ("Read-only. Lists the user's writing skills (name, description): guides for "
                            "drafting emails, letters and other texts. Call it before writing something."),
        **pg_query("assistant/sql/list_skills.sql",
                   "={{ [ $fromAI('filter', 'Optional word to filter skills by name or description. Empty string for all', 'string') ] }}")})
    w.node("Skills: read", "n8n-nodes-base.postgresTool", 2.6, [2880, 640], {
        "descriptionType": "manual",
        "toolDescription": "Read-only. Returns the full text of one writing skill by its name (from Skills: list).",
        **pg_query("assistant/sql/read_skill.sql",
                   "={{ [ $fromAI('name', 'The skill name, e.g. email', 'string') ] }}")})
    w.node("Parse + validate", "n8n-nodes-base.code", 2, [2200, 400],
           code("assistant/parse_agent_output.js", REPLY=REPLY))

    # ── Reply ───────────────────────────────────────────────
    w.node("Voice or text?", "n8n-nodes-base.switch", 3.2, [2420, 300], {
        "mode": "expression", "numberOutputs": len(REPLY), "output": "={{ $json.replyRoute }}"})
    w.node("Speak reply", "n8n-nodes-base.executeWorkflow", 1.2, [2640, 220], exec_speak())
    w.node("Send text reply", "n8n-nodes-base.httpRequest", 4.2, [2640, 380], http_json(
        "POST", f"={TG}/sendMessage",
        "={{ JSON.stringify({ chat_id: $json.chatId, text: $json.reply }) }}"),
        retryOnFail=True, maxTries=3, waitBetweenTries=3000)

    # ── Proposals → approval cards ──────────────────────────
    w.node("One item per proposal", "n8n-nodes-base.code", 2, [2420, 560],
           code("assistant/proposals_to_items.js"))
    w.node("Save proposal", "n8n-nodes-base.postgres", 2.6, [2640, 560], pg_query(
        "assistant/sql/insert_proposal.sql",
        f"={{{{ [ $json.chatId, $json.kind, $json.payload, $json.summary, {cfg}.proposalTtlHours ] }}}}"))
    w.node("Send approval card", "n8n-nodes-base.httpRequest", 4.2, [2860, 560], http_json(
        "POST", f"={TG}/sendMessage",
        "={{ JSON.stringify({\n"
        "  chat_id: $json.chat_id,\n"
        f"  text: $json.summary + '\\n\\nApprove to add it. Expires in ' + {cfg}.proposalTtlHours + ' h.',\n"
        "  reply_markup: { inline_keyboard: [[\n"
        "    { text: '✅ Approve', callback_data: 'ap:' + $json.id },\n"
        "    { text: '❌ Decline', callback_data: 'no:' + $json.id }\n"
        "  ]] }\n"
        "}) }}"), retryOnFail=True, maxTries=3, waitBetweenTries=3000)

    # ── /style command: plain node, the agent never writes the setting ──
    w.node("Set style", "n8n-nodes-base.postgres", 2.6, [820, 1160], pg_query(
        "assistant/sql/set_style.sql", "={{ [ $json.chatId, $json.styleArg ] }}"))
    w.node("Send style reply", "n8n-nodes-base.httpRequest", 4.2, [1040, 1160], http_json(
        "POST", f"={TG}/sendMessage",
        f"={{{{ JSON.stringify({{ chat_id: {route}.chatId, text: $json.reply }}) }}}}"),
        retryOnFail=True, maxTries=3, waitBetweenTries=3000)

    # ── Button tap → atomic decision → deterministic execution ──
    w.node("Claim decision", "n8n-nodes-base.postgres", 2.6, [820, 880], pg_query(
        "assistant/sql/claim_decision.sql",
        "={{ [ $json.proposalId, $json.action, $json.chatId ] }}"), alwaysOutputData=True)
    w.node("Decision outcome", "n8n-nodes-base.code", 2, [1040, 880], code("assistant/callback_outcome.js", OUTCOME=OUTCOME))
    w.node("Approved?", "n8n-nodes-base.switch", 3.2, [1260, 880], {
        "mode": "expression", "numberOutputs": len(OUTCOME), "output": "={{ $json.route }}"})
    w.node("Create calendar event", "n8n-nodes-base.googleCalendar", 1.3, [1480, 780], {
        "resource": "event", "operation": "create", "calendar": PRIMARY_CAL,
        "start": "={{ $json.payload.start }}",
        "end": "={{ $json.payload.end }}",
        "useDefaultReminders": True,
        "additionalFields": {
            "summary": "={{ $json.payload.title }}",
            "location": "={{ $json.payload.location }}",
            "description": "={{ ($json.payload.description ? $json.payload.description + '\\n\\n' : '') + 'Suggested by Jarvis, approved in Telegram.' }}",
            "sendUpdates": "none",
        },
    }, onError="continueErrorOutput")
    w.node("Mark executed", "n8n-nodes-base.postgres", 2.6, [1700, 720], pg_query(
        "assistant/sql/mark_executed.sql",
        f"={{{{ [ {route}.proposalId, {{ eventId: $json.id, link: $json.htmlLink }} ] }}}}"))
    w.node("Mark failed", "n8n-nodes-base.postgres", 2.6, [1700, 880], pg_query(
        "assistant/sql/mark_failed.sql",
        f"={{{{ [ {route}.proposalId, String($json.error?.message || $json.error || 'unknown error') ] }}}}"))
    w.node("Answer button", "n8n-nodes-base.httpRequest", 4.2, [1960, 820], http_json(
        "POST", f"={TG}/answerCallbackQuery",
        f"={{{{ JSON.stringify({{ callback_query_id: {route}.callbackId, text: $json.toast }}) }}}}"),
        onError="continueRegularOutput")
    w.node("Update card", "n8n-nodes-base.httpRequest", 4.2, [1960, 980], http_json(
        "POST", f"={TG}/editMessageText",
        "={{ JSON.stringify({\n"
        f"  chat_id: {route}.chatId,\n"
        f"  message_id: {route}.messageId,\n"
        "  text: $json.editText,\n"
        "  reply_markup: { inline_keyboard: [] }\n"
        "}) }}"), onError="continueRegularOutput")

    # ── Wiring ──────────────────────────────────────────────
    w.chain("Telegram Trigger", "Config", "Route update", "Route")
    w.link("Route", "Show typing", ROUTE["voice"])
    w.link("Route", "Get voice file path", ROUTE["voice"])
    w.link("Route", "Show typing", ROUTE["text"])
    w.link("Route", "Load style", ROUTE["text"])
    w.link("Route", "Claim decision", ROUTE["callback"])
    w.link("Route", "Set style", ROUTE["style"])
    w.chain("Get voice file path", "Download voice", "Audio to base64", "Gemini: transcribe", "Load style")
    w.chain("Load style", "Prepare agent input", "Jarvis", "Parse + validate")
    w.link("Set style", "Send style reply")
    w.link("Gemini chat model", "Jarvis", kind="ai_languageModel")
    w.link("Chat memory", "Jarvis", kind="ai_memory")
    for tool in ("Calendar: list events", "Gmail: search", "Gmail: read email",
                 "Uni mail: search", "Uni mail: read email", "Skills: list", "Skills: read"):
        w.link(tool, "Jarvis", kind="ai_tool")
    w.link("Parse + validate", "Voice or text?")
    w.link("Parse + validate", "One item per proposal")
    w.link("Voice or text?", "Speak reply", REPLY["voice"])
    w.link("Voice or text?", "Send text reply", REPLY["text"])
    w.chain("One item per proposal", "Save proposal", "Send approval card")
    w.chain("Claim decision", "Decision outcome", "Approved?")
    w.link("Approved?", "Create calendar event", OUTCOME["create"])
    w.link("Approved?", "Answer button", OUTCOME["cardOnly"])
    w.link("Approved?", "Update card", OUTCOME["cardOnly"])
    w.link("Create calendar event", "Mark executed", 0)
    w.link("Create calendar event", "Mark failed", 1)
    for n in ("Mark executed", "Mark failed"):
        w.link(n, "Answer button")
        w.link(n, "Update card")
    return "workflow_assistant.json", w


# ═══════════════════════════════════════════════════════════════════
# 4) UNIVERSITY MAIL → DATABASE (IMAP, read-only on the mailbox)
#    postProcessAction "nothing": the mailbox is never modified (no "mark as read").
#    "Fetch only new emails" tracks the last UID, so ["ALL"] also catches mails already
#    opened in webmail; Message-ID makes re-delivery a no-op.
# ═══════════════════════════════════════════════════════════════════
def build_unimail():
    w = WF(UNIMAIL_ID, "University mail → database (IMAP, read-only)")
    w.node("University inbox (IMAP)", "n8n-nodes-base.emailReadImap", 2.2, [0, 300], {
        "mailbox": "INBOX",
        "postProcessAction": "nothing",
        "downloadAttachments": False,
        "format": "simple",
        "options": {"customEmailConfig": '["ALL"]', "trackLastMessageId": True},
    })
    w.node("Normalize email", "n8n-nodes-base.code", 2, [220, 300], code("unimail/normalize_email.js"))
    w.node("Save uni email", "n8n-nodes-base.postgres", 2.6, [440, 300], pg_query(
        "assistant/sql/insert_uni_email.sql",
        "={{ [ $json.messageId, $json.from, $json.to, $json.subject, $json.body, $json.receivedAt ] }}"))
    w.chain("University inbox (IMAP)", "Normalize email", "Save uni email")
    return "workflow_university_mail.json", w


BUILDERS = (build_speak, build_briefing, build_assistant, build_unimail)


def build_all():
    """{filename: WF} for every workflow. Pure: writes nothing (the audit relies on this)."""
    return dict(b() for b in BUILDERS)


# ═══════════════════════════════════════════════════════════════════
# 5) GUIDES: skills/*.md → 02-skills.sql, styles/*.md → 03-styles.sql
#    Same file format: '---' front matter with one 'description:' line, then the body.
# ═══════════════════════════════════════════════════════════════════
INIT_DIR = ROOT / "docker" / "postgres" / "init"
SKILLS_DIR, SKILLS_SQL = ROOT / "skills", INIT_DIR / "02-skills.sql"
STYLES_DIR, STYLES_SQL = ROOT / "styles", INIT_DIR / "03-styles.sql"
GUIDE_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
# A style body is added to the system prompt on every message: keep it short.
GUIDES = {
    "skills": {"dir": SKILLS_DIR, "sql": SKILLS_SQL, "max_body": 20000, "reserved": ()},
    "styles": {"dir": STYLES_DIR, "sql": STYLES_SQL, "max_body": 2000, "reserved": ("off",)},
}


def parse_guide(path, kind="skills"):
    """<kind>/<name>.md with a '---' front matter holding one 'description:' line."""
    g, where = GUIDES[kind], f"{kind}/{path.name}"
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n").lstrip("﻿")
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not m:
        raise SystemExit(f"{where}: missing '---' front matter")
    meta = dict(line.split(":", 1) for line in m.group(1).splitlines() if ":" in line)
    name, desc, body = path.stem, meta.get("description", "").strip(), m.group(2).strip()
    if not GUIDE_NAME.match(name):
        raise SystemExit(f"{where}: file name must be lowercase letters, digits and '-'")
    if name in g["reserved"]:
        raise SystemExit(f"{where}: '{name}' is a reserved name")
    if not desc or len(desc) > 300:
        raise SystemExit(f"{where}: description must be 1-300 characters")
    if not body or len(body) > g["max_body"]:
        raise SystemExit(f"{where}: body must be 1-{g['max_body']} characters")
    if "\x00" in desc + body:
        raise SystemExit(f"{where}: contains a NUL character")
    return name, desc, body


def sql_str(s):
    # standard_conforming_strings is on by default: only quotes need doubling.
    return "'" + s.replace("'", "''") + "'"


def guides_sql(kind):
    """Returns (sql_text, count) for skills or styles. The audit compares this with the committed file."""
    g = GUIDES[kind]
    table, fname = f"assistant.{kind}", g["sql"].name
    items = [parse_guide(p, kind) for p in sorted(g["dir"].glob("*.md"))]
    lines = [
        f"-- GENERATED by src/build_workflows.py from {kind}/*.md. Edit those files, then regenerate.",
        "-- Runs automatically on a FRESH postgres volume, after 01-assistant.sql.",
        f"-- Existing volume? Re-apply after every {kind} change (idempotent, removes deleted {kind}):",
        "--   docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" "
        f"-d \"$POSTGRES_DB\" -f /docker-entrypoint-initdb.d/{fname}'",
        "BEGIN;",
    ]
    if items:
        names = ", ".join(sql_str(n) for n, _, _ in items)
        rows = ",\n".join(f"({sql_str(n)},\n {sql_str(d)},\n {sql_str(b)})" for n, d, b in items)
        lines += [
            f"DELETE FROM {table} WHERE name NOT IN ({names});",
            f"INSERT INTO {table} (name, description, body) VALUES",
            rows,
            "ON CONFLICT (name) DO UPDATE",
            "   SET description = EXCLUDED.description, body = EXCLUDED.body, updated_at = now()",
            f" WHERE ({table}.description, {table}.body)",
            "       IS DISTINCT FROM (EXCLUDED.description, EXCLUDED.body);",
        ]
    else:
        lines.append(f"DELETE FROM {table};")
    lines.append("COMMIT;")
    return "\n".join(lines) + "\n", len(items)


def skills_sql():
    return guides_sql("skills")


def styles_sql():
    return guides_sql("styles")


def build_guides():
    for kind, g in GUIDES.items():
        text, count = guides_sql(kind)
        g["sql"].write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {g['sql'].relative_to(ROOT).as_posix()}: {count} {kind[:-1]}(s)")


def lint_expressions():
    """Catch literal '{{' / '}}' that n8n would misread as expressions."""
    def walk(v, path, where):
        if isinstance(v, dict):
            for k, x in v.items():
                walk(x, f"{path}.{k}", where)
        elif isinstance(v, list):
            for i, x in enumerate(v):
                walk(x, f"{path}[{i}]", where)
        elif isinstance(v, str) and path.split(".")[-1] not in ("jsCode", "query"):
            if v.count("{{") != v.count("}}"):
                raise SystemExit(f"{where}{path}: unbalanced {{{{ }}}}")
            if "{{" in v and not v.startswith("="):
                raise SystemExit(f"{where}{path}: expression without '=' prefix")

    for f in OUT.glob("*.json"):
        wf = json.loads(f.read_text(encoding="utf-8"))
        for n in wf["nodes"]:
            walk(n["parameters"], "", f"{f.name}:{n['name']}")


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for filename, w in build_all().items():
        w.write(filename)
    build_guides()
    lint_expressions()
    print("expression lint OK")
