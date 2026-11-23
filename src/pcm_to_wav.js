// Code node: "PCM to WAV" (Run Once for All Items)
// Gemini TTS returns raw 16-bit little-endian mono PCM (audio/L16;rate=24000)
// as base64 in candidates[0].content.parts[0].inlineData.data.
// Telegram can't play raw PCM, so we wrap it in a WAV header here and let
// ffmpeg transcode WAV -> OGG/Opus in the next step.

const res = $input.first().json;
const part = (res.candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.data);
if (!part) {
  throw new Error('Gemini TTS returned no audio. Raw: ' + JSON.stringify(res).slice(0, 500));
}

const pcm = Buffer.from(part.inlineData.data, 'base64');
const mime = part.inlineData.mimeType || '';
const sampleRate = parseInt((mime.match(/rate=(\d+)/) || [])[1] || '24000', 10);
const channels = 1;
const bitsPerSample = 16;
const blockAlign = channels * bitsPerSample / 8;
const byteRate = sampleRate * blockAlign;

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);          // PCM fmt chunk size
header.writeUInt16LE(1, 20);           // audio format = PCM
header.writeUInt16LE(channels, 22);
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(byteRate, 28);
header.writeUInt16LE(blockAlign, 32);
header.writeUInt16LE(bitsPerSample, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);

const wav = Buffer.concat([header, pcm]);

return [{
  json: {
    sourceMimeType: mime,
    sampleRate,
    durationSec: Number((pcm.length / byteRate).toFixed(1)),
  },
  binary: {
    data: {
      data: wav.toString('base64'),
      mimeType: 'audio/wav',
      fileName: 'briefing.wav',
      fileExtension: 'wav',
    },
  },
}];
