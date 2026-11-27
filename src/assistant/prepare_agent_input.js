// Code node "Prepare agent input" (Run Once for All Items)
// Joins the voice path (Gemini transcript) and the text path into one shape, and
// passes on the answer style chosen with /style. Input: the "Load style" row
// ({ style, body }, both null when none is chosen; an error item if the lookup failed).

const r = $('Route update').first().json;
let userText = r.text;

if (r.kind === 'voice') {
  const res = $('Gemini: transcribe').first().json;
  userText = (res.candidates?.[0]?.content?.parts || [])
    .filter(p => !p.thought && typeof p.text === 'string')
    .map(p => p.text)
    .join(' ')
    .trim();
  if (!userText) userText = '[The voice message was empty or inaudible.]';
}

// A failed style lookup must never block the assistant: fall back to the default style.
const st = $input.first().json || {};
const hasStyle = typeof st.style === 'string' && typeof st.body === 'string' && st.body.trim() !== '';

return [{
  json: {
    chatId: r.chatId,
    inputMode: r.kind,                    // 'voice' | 'text'
    userText: String(userText).slice(0, 4000),
    sessionKey: `telegram-${r.chatId}`,   // Postgres chat memory key
    style: hasStyle ? st.style : '',
    styleBody: hasStyle ? st.body.trim().slice(0, 2000) : '',
  },
}];
