// Code node "Speech-safe text" (Run Once for All Items)
// First step of the Speak sub-workflow: whatever any caller sends, strip what a
// TTS voice would read badly. The result replaces `text` for TTS, the default
// caption and the text fallback. An explicit `caption` is left as the caller gave it.

const forSpeech = s => String(s ?? '')
  .replace(/https?:\/\/\S+/gi, '')              // URLs
  .replace(/\S+@\S+\.\S+/g, '')                  // email addresses
  .replace(/^\s*[-•*]\s+/gm, '')                 // bullet markers
  .replace(/[*_#`>~|[\]{}<>]/g, '')              // markdown / display chars
  .replace(/\p{Extended_Pictographic}/gu, '')    // emojis
  .replace(/\s[-–—]\s/g, ', ')                   // inline dashes -> pause
  .replace(/\s+/g, ' ')
  .replace(/\s+([.,!?;:])/g, '$1')               // no space before punctuation
  .replace(/([.,!?;:]),/g, '$1')                 // no doubled punctuation
  .trim();

return $input.all().map(({ json }) => {
  const original = String(json.text ?? '').trim();
  // Nothing speakable left (e.g. emoji-only): keep the original rather than send TTS an empty input.
  return { json: { ...json, text: forSpeech(original) || original } };
});
