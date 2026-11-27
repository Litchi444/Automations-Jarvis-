// Code node: "Clean script" (Run Once for All Items)
// Extracts Gemini's text and enforces the character budget on a sentence
// boundary. Speech cleaning (URLs, markdown, emoji…) happens in the Speak
// sub-workflow ("Speech-safe text"); it only ever shortens the text.

const cfg = $('Config').first().json;
const maxChars = Number(cfg.maxChars) || 300;
const res = $input.first().json;

const parts = res.candidates?.[0]?.content?.parts || [];
let text = parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join(' ')
  .replace(/\s+/g, ' ')
  .trim();

if (!text) {
  throw new Error('Gemini returned no text. Raw: ' + JSON.stringify(res).slice(0, 500));
}

if (text.length > maxChars) {
  const cut = text.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '),
    /[.!?]$/.test(cut) ? cut.length - 1 : -1);
  text = lastStop > maxChars * 0.5
    ? cut.slice(0, lastStop + 1)
    : cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '') + '.';
}

// `text` is the input contract of the "Speak" sub-workflow.
return [{ json: { script: text, text, chars: text.length } }];
