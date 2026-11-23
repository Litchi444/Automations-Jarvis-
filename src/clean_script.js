// Code node: "Clean script" (Run Once for All Items)
// Extracts Gemini's text, strips anything a TTS voice would read badly,
// and enforces the character budget on a sentence boundary.

const cfg = $('Config').first().json;
const maxChars = Number(cfg.maxChars) || 300;
const res = $input.first().json;

const parts = res.candidates?.[0]?.content?.parts || [];
let text = parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join(' ');

if (!text.trim()) {
  throw new Error('Gemini returned no text. Raw: ' + JSON.stringify(res).slice(0, 500));
}

text = text
  .replace(/https?:\/\/\S+/gi, '')              // URLs
  .replace(/\S+@\S+\.\S+/g, '')                  // email addresses
  .replace(/^\s*[-•*]\s+/gm, '')                 // bullet markers
  .replace(/[*_#`>~|\[\]{}<>]/g, '')             // markdown / display chars
  .replace(/\p{Extended_Pictographic}/gu, '')    // emojis
  .replace(/\s[-–—]\s/g, ', ')                   // inline dashes -> pause
  .replace(/\s+/g, ' ')
  .replace(/\s+([.,!?;:])/g, '$1')               // no space before punctuation
  .replace(/([.,!?;:]),/g, '$1')                 // no doubled punctuation
  .trim();

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
