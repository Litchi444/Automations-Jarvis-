// Code node "Route update" (Run Once for All Items)
// Authoritative access control + routing. The trigger's chat filter is the
// first gate; this is the second. Anything not from your private chat is
// dropped silently (returning [] ends the execution).
//
// Output `route`: 0 = voice, 1 = text, 2 = button tap (callback)

const allowed = String($env.TELEGRAM_CHAT_ID || '').trim();
if (!allowed) throw new Error('TELEGRAM_CHAT_ID is not set in the environment');

const u = $('Telegram Trigger').first().json;
const MAX_VOICE_SECONDS = 300;

// ── Button taps ───────────────────────────────────────────────
if (u.callback_query) {
  const cq = u.callback_query;
  const chatId = String(cq.message?.chat?.id ?? '');
  const fromId = String(cq.from?.id ?? '');
  if (chatId !== allowed || fromId !== allowed) return [];

  const m = String(cq.data || '').match(/^(ap|no):(\d{1,18})$/);
  if (!m) return [];

  return [{
    json: {
      route: 2,
      kind: 'callback',
      chatId,
      callbackId: cq.id,
      messageId: cq.message.message_id,
      action: m[1] === 'ap' ? 'approve' : 'decline',
      proposalId: m[2],
    },
  }];
}

// ── Messages ────────────────────────────────────────────────────
const msg = u.message;
if (!msg) return [];

const chatId = String(msg.chat?.id ?? '');
if (msg.chat?.type !== 'private' || chatId !== allowed || String(msg.from?.id ?? '') !== allowed) {
  return [];
}

const audio = msg.voice || msg.audio;
if (audio) {
  if ((audio.duration || 0) > MAX_VOICE_SECONDS) {
    return [{ json: { route: 1, kind: 'text', chatId,
      text: `[System note: the user sent a voice message longer than ${MAX_VOICE_SECONDS / 60} minutes, which was not processed. Ask them to send a shorter one.]` } }];
  }
  return [{
    json: {
      route: 0,
      kind: 'voice',
      chatId,
      fileId: audio.file_id,
      mimeType: audio.mime_type || 'audio/ogg',
    },
  }];
}

if (typeof msg.text === 'string' && msg.text.trim()) {
  const text = msg.text.trim() === '/start' ? 'Hello! Briefly introduce yourself.' : msg.text.trim();
  return [{ json: { route: 1, kind: 'text', chatId, text } }];
}

return []; // stickers, photos, etc.: ignored
