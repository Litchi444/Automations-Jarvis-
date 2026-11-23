// Code node "Prepare agent input" (Run Once for All Items)
// Joins the voice path (Gemini transcript) and the text path into one shape.

const r = $('Route update').first().json;
let userText = r.text;

if (r.kind === 'voice') {
  const res = $input.first().json;
  userText = (res.candidates?.[0]?.content?.parts || [])
    .filter(p => !p.thought && typeof p.text === 'string')
    .map(p => p.text)
    .join(' ')
    .trim();
  if (!userText) userText = '[The voice message was empty or inaudible.]';
}

return [{
  json: {
    chatId: r.chatId,
    inputMode: r.kind,                    // 'voice' | 'text'
    userText: String(userText).slice(0, 4000),
    sessionKey: `telegram-${r.chatId}`,   // Postgres chat memory key
  },
}];
