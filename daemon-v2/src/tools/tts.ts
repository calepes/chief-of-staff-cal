import { writeFile, readFile, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FFMPEG = "/opt/homebrew/bin/ffmpeg";

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function timeToSpeech(hStr: string, mStr: string): string {
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (h === 0 && m === 0) return "medianoche";
  if (h === 12 && m === 0) return "mediodía";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const period = h >= 6 && h < 12 ? "de la mañana"
    : h === 12 ? "del mediodía"
    : h >= 13 && h < 20 ? "de la tarde"
    : "de la noche";
  if (m === 0) return `${h12} ${period}`;
  if (m === 30) return `${h12} y media ${period}`;
  if (m === 15) return `${h12} y cuarto ${period}`;
  if (m === 45) return `${h12} menos cuarto ${period}`;
  return `${h12} y ${m} ${period}`;
}

function prepareForSpeech(text: string): string {
  let s = stripHtml(text);
  // Horas: 08:30 → 8 y media de la mañana
  s = s.replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => timeToSpeech(h, m));
  // Moneda boliviana
  s = s.replace(/Bs\s*([\d.,]+)/g, (_, n) => `${n} bolivianos`);
  // Porcentajes
  s = s.replace(/(\d+)%/g, "$1 por ciento");
  // Bullets y guiones de lista al inicio de línea → pausa natural
  s = s.replace(/^[\s]*[•\-\*]\s+/gm, "");
  // Símbolos visuales que no suenan bien
  s = s.replace(/[*_~`#]+/g, "");
  // Emojis que quedan solos o dobles → espacio
  s = s.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]/gu, " ");
  // Saltos de línea → pausa
  s = s.replace(/\n+/g, ". ");
  // Limpiar espacios múltiples
  s = s.replace(/\s+/g, " ").replace(/\.\s*\./g, ".").trim();
  return s;
}

const TTS_CHUNK = 4800;

function chunkForSpeech(text: string, maxLen = TTS_CHUNK): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rem = text;
  while (rem.length > 0) {
    if (rem.length <= maxLen) { chunks.push(rem); break; }
    let cut = maxLen;
    const para = rem.lastIndexOf(". ", maxLen);
    if (para > maxLen / 2) { cut = para + 2; }
    else {
      const space = rem.lastIndexOf(" ", maxLen);
      if (space > maxLen / 2) cut = space + 1;
    }
    chunks.push(rem.slice(0, cut).trimEnd());
    rem = rem.slice(cut).trimStart();
  }
  return chunks.filter(Boolean);
}

async function synthesizeChunk(chunk: string, apiKey: string, voiceId: string): Promise<Buffer> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: chunk,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs ${res.status}: ${err.slice(0, 200)}`);
  }
  const mp3 = Buffer.from(await res.arrayBuffer());
  const id = randomBytes(6).toString("hex");
  const mp3Path = `/tmp/tts-${id}.mp3`;
  const oggPath = `/tmp/tts-${id}.ogg`;
  await writeFile(mp3Path, mp3);
  await execFileAsync(FFMPEG, ["-y", "-i", mp3Path, "-c:a", "libopus", "-b:a", "64k", oggPath]);
  const ogg = await readFile(oggPath);
  await Promise.allSettled([unlink(mp3Path), unlink(oggPath)]);
  return ogg;
}

// Returns one OGG buffer per chunk (multiple voice messages for long text).
export async function textToVoiceOggChunks(
  text: string,
  apiKey: string,
  voiceId: string,
): Promise<Buffer[]> {
  const clean = prepareForSpeech(text);
  const chunks = chunkForSpeech(clean);
  const buffers: Buffer[] = [];
  for (const chunk of chunks) {
    buffers.push(await synthesizeChunk(chunk, apiKey, voiceId));
  }
  return buffers;
}

export async function textToVoiceOgg(
  text: string,
  apiKey: string,
  voiceId: string,
): Promise<Buffer> {
  const clean = prepareForSpeech(text).slice(0, TTS_CHUNK);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: clean,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    },
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs ${res.status}: ${err.slice(0, 200)}`);
  }

  const mp3 = Buffer.from(await res.arrayBuffer());

  const id = randomBytes(6).toString("hex");
  const mp3Path = `/tmp/tts-${id}.mp3`;
  const oggPath = `/tmp/tts-${id}.ogg`;

  await writeFile(mp3Path, mp3);
  await execFileAsync(FFMPEG, [
    "-y", "-i", mp3Path,
    "-c:a", "libopus", "-b:a", "64k",
    oggPath,
  ]);

  const ogg = await readFile(oggPath);
  await Promise.allSettled([unlink(mp3Path), unlink(oggPath)]);

  return ogg;
}
