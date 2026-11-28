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
  // The transcriber only accepts French and English and answers UNCLEAR when it is unsure
  // (prompt in src/build_workflows.py). Then Jarvis must not guess: it asks to repeat.
  if (!userText || /^\W*\[?UNCLEAR\]?\W*$/i.test(userText)) {
    userText = "[System note: the user's voice message could not be understood (inaudible, unclear, "
      + 'or not in French or English). Do not guess what they meant and propose nothing. '
      + 'Briefly ask them, in French, to repeat, in French or English.]';
  }
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
