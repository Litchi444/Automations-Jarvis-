# H1: Credentials (human checkpoint)
owner: human · skippable: no

Only you can sign in to Google and paste API keys. The manager shows you this list and waits.

## Checklist (details in README §4–5)
1. Google Cloud: OAuth client (Web), redirect URI = `<WEBHOOK_URL>rest/oauth2-credential/callback`, consent screen **published to In production**.
2. In n8n → Credentials, create:
   - Google Calendar OAuth2 API → Sign in
   - Gmail OAuth2 API → Sign in
   - Header Auth "Gemini API key": name `x-goog-api-key`, value = AI Studio key
   - Google Gemini (PaLM) API: host `https://generativelanguage.googleapis.com` + key
   - Postgres: host `postgres`, port 5432, DB/user/password from `.env`, SSL off
   - Telegram API: bot token
   - IMAP "University mail": university login + password (the USER types them), host `imap.univ-lemans.fr`, port 993, SSL/TLS on
3. Open each workflow and attach credentials to every node showing a warning:
   - Speak: Gemini TTS
   - Briefing: Calendar, Gmail, Get uni emails (Postgres), Gemini
   - Assistant: Telegram Trigger, Gemini transcribe, chat model, chat memory, 5 tools (2 are Postgres), 3 Postgres, Create calendar event
   - University mail: IMAP trigger, Save uni email (Postgres)
4. Optional but recommended: n8n Settings → n8n API → create an API key and add `N8N_API_KEY=...` to `.env`. It lets the agents read execution results for you.

## Answers the manager accepts
- **done** → continue to P4
- **need help** → the manager asks which step, and answers from README
