# Research Competencia Fase 2 (RRSS multimodal) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sumar Instagram, TikTok, Facebook y X como fuentes del research de competencia, procesando tanto posts estáticos como videos con análisis multimodal (visión + transcripción).

**Architecture:** Se reusan 4 piezas ya en producción: `cookie-jar.ts` (cookies logueadas desde el KV neutral), el patrón Playwright headless in-process de `design-capture.ts`, `vision.ts::analyzePhoto()` (OpenRouter/qwen3-vl) y `whisper.ts::transcribeAudio()` (ElevenLabs con fallback local). Dos módulos nuevos: `research-competencia-media.ts` (genérico: descarga, ffmpeg, visión, transcripción — no sabe nada de redes sociales) y `research-competencia-social.ts` (scraping por plataforma + orquestación). El texto consolidado entra al prompt del agente como un dato mecánico más, sin tocar el contrato de hallazgos/battlecard de Fase 1.

**Tech Stack:** TypeScript, Playwright 1.62.1, ffmpeg/ffprobe 9.0.1 (`/opt/homebrew/bin/`), vitest, OpenRouter (visión), ElevenLabs/whisper.cpp (audio).

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `daemon-v2/src/tools/research-competencia-media.ts` (nuevo) | Descarga de media, ffmpeg (audio + frames), visión y transcripción. Genérico: recibe URLs, devuelve texto. |
| `daemon-v2/src/tools/research-competencia-social.ts` (nuevo) | Tipos de post, scrapers por plataforma (Playwright), filtro de timeframe, topes, consolidación a texto. |
| `daemon-v2/src/tools/research-competencia-entities.ts` (modificar) | `EntityConfig` suma handles de las 4 plataformas. |
| `daemon-v2/src/tools/research-competencia.ts` (modificar) | Orquestador: inyecta cookies, llama al social, suma `socialText` a los facts. |
| `daemon-v2/src/tools/research-competencia-agent.ts` (modificar) | `MechanicalFacts` suma `socialText`; el prompt reconoce RRSS como fuente citable. |
| `daemon-v2/scripts/research-competencia-now.ts` + `package.json` (modificar) | El script corre bajo `op run` para tener las credenciales de CF/OpenRouter/ElevenLabs. |
| `~/.claude/config/cookie-jar-domains.json` (fuera del repo) | Whitelist de los 4 dominios sociales. |

**Topes (del spec):** 8 posts por cuenta, 4 videos por cuenta, 6 frames por video, se saltean videos de más de 5 min.

---

### Task 1: Módulo de media — descarga y descripción de imágenes

**Files:**
- Create: `daemon-v2/src/tools/research-competencia-media.ts`
- Test: `daemon-v2/src/tools/research-competencia-media.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("./vision.js", () => ({
  analyzePhoto: vi.fn(async () => ({ text: "Un flyer con la promo 2x1", rawTokens: { input: 1, output: 1 } })),
}));

import { downloadMedia, describeImage } from "./research-competencia-media.js";
import { analyzePhoto } from "./vision.js";

describe("downloadMedia", () => {
  it("devuelve false si la respuesta no es ok, sin tirar excepción", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await downloadMedia("https://x.com/a.jpg", "/tmp/no-existe-rc.jpg", fetchFn)).toBe(false);
  });

  it("devuelve false si fetch tira, sin propagar el error", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    expect(await downloadMedia("https://x.com/a.jpg", "/tmp/no-existe-rc.jpg", fetchFn)).toBe(false);
  });
});

describe("describeImage", () => {
  it("devuelve el texto de visión cuando la descarga funciona", async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;
    expect(await describeImage("https://cdn/x.jpg", fetchFn)).toBe("Un flyer con la promo 2x1");
    expect(analyzePhoto).toHaveBeenCalled();
  });

  it("devuelve null si la descarga falla, sin llamar a visión", async () => {
    vi.mocked(analyzePhoto).mockClear();
    const fetchFn = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    expect(await describeImage("https://cdn/x.jpg", fetchFn)).toBeNull();
    expect(analyzePhoto).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-media.test.ts`
Expected: FAIL — "Failed to resolve import ./research-competencia-media.js"

- [ ] **Step 3: Implementar**

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzePhoto } from "./vision.js";

export const execFileAsync = promisify(execFile);
export const FFMPEG = "/opt/homebrew/bin/ffmpeg";
export const FFPROBE = "/opt/homebrew/bin/ffprobe";

/** Descarga una URL de media a disco. Devuelve false ante cualquier falla — nunca tira. */
export async function downloadMedia(url: string, destPath: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(url, {
      signal: AbortSignal.timeout(30_000),
      // Los CDN de IG/TikTok/FB devuelven 403 a clientes sin User-Agent de browser.
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" },
    });
    if (!res.ok) return false;
    await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

/** Descarga una imagen y la describe con visión. null si algo falla — nunca tira. */
export async function describeImage(url: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "rc-img-"));
  try {
    const path = join(dir, "image.jpg");
    if (!(await downloadMedia(url, path, fetchFn))) return null;
    const analysis = await analyzePhoto({ imagePath: path, task: "describe" });
    return analysis.text.trim() || null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-media.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck y commit**

```bash
cd daemon-v2 && npx tsc --noEmit
git add daemon-v2/src/tools/research-competencia-media.ts daemon-v2/src/tools/research-competencia-media.test.ts
git commit -m "feat(research-competencia): módulo de media con descarga y descripción de imágenes"
```

---

### Task 2: Módulo de media — análisis de video (transcripción + frames)

**Files:**
- Modify: `daemon-v2/src/tools/research-competencia-media.ts`
- Test: `daemon-v2/src/tools/research-competencia-media.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Agregar al final de `research-competencia-media.test.ts` (y sumar `analyzeVideo`, `videoDurationSec` al import existente desde `./research-competencia-media.js`, más el mock de whisper arriba junto al de vision):

```typescript
vi.mock("./whisper.js", () => ({
  transcribeAudio: vi.fn(async () => "Hola, te presentamos el nuevo crédito digital"),
}));
```

```typescript
import { analyzeVideo, MAX_VIDEO_DURATION_SEC } from "./research-competencia-media.js";
import { transcribeAudio } from "./whisper.js";

describe("analyzeVideo", () => {
  it("devuelve null si la descarga falla, sin invocar ffmpeg", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await analyzeVideo("https://cdn/v.mp4", { fetchFn })).toBeNull();
  });

  it("saltea videos más largos que el tope y devuelve null", async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof fetch;
    const durationFn = vi.fn(async () => MAX_VIDEO_DURATION_SEC + 1);
    expect(await analyzeVideo("https://cdn/v.mp4", { fetchFn, durationFn })).toBeNull();
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("devuelve transcripción y descripciones de frames", async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof fetch;
    const durationFn = vi.fn(async () => 20);
    // Simula ffmpeg: no corre nada, y deja 2 frames "creados" para que los lea readdir.
    const runFfmpegFn = vi.fn(async (_args: string[], dir: string) => {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await writeFile(join(dir, "frame_01.jpg"), Buffer.from([1]));
      await writeFile(join(dir, "frame_02.jpg"), Buffer.from([1]));
    });

    const result = await analyzeVideo("https://cdn/v.mp4", { fetchFn, durationFn, runFfmpegFn });

    expect(result?.transcripcion).toContain("crédito digital");
    expect(result?.frames).toHaveLength(2);
    expect(result?.frames[0]).toBe("Un flyer con la promo 2x1");
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-media.test.ts`
Expected: FAIL — "analyzeVideo is not a function"

- [ ] **Step 3: Implementar**

Agregar a `research-competencia-media.ts` (sumar `transcribeAudio` al import de `./whisper.js`):

```typescript
import { transcribeAudio } from "./whisper.js";

export const MAX_FRAMES_PER_VIDEO = 6;
export const MAX_VIDEO_DURATION_SEC = 300;

export interface VideoAnalysis {
  transcripcion: string;
  frames: string[];
}

export interface AnalyzeVideoOpts {
  maxFrames?: number;
  fetchFn?: typeof fetch;
  durationFn?: (videoPath: string) => Promise<number | null>;
  runFfmpegFn?: (args: string[], dir: string) => Promise<void>;
}

/** Duración en segundos vía ffprobe. null si no se puede determinar. */
export async function videoDurationSec(videoPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(FFPROBE, [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", videoPath,
    ]);
    const d = Number(stdout.trim());
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

async function defaultRunFfmpeg(args: string[]): Promise<void> {
  await execFileAsync(FFMPEG, args);
}

/**
 * Descarga un video, transcribe su audio y describe frames muestreados parejo a lo largo del
 * video. Devuelve null si la descarga falla, si supera MAX_VIDEO_DURATION_SEC, o si no se pudo
 * sacar ni transcripción ni un solo frame. Nunca tira: un video roto no corta la corrida.
 */
export async function analyzeVideo(url: string, opts: AnalyzeVideoOpts = {}): Promise<VideoAnalysis | null> {
  const maxFrames = opts.maxFrames ?? MAX_FRAMES_PER_VIDEO;
  const fetchFn = opts.fetchFn ?? fetch;
  const durationFn = opts.durationFn ?? videoDurationSec;
  const runFfmpeg = opts.runFfmpegFn ?? ((args: string[]) => defaultRunFfmpeg(args));

  const dir = await mkdtemp(join(tmpdir(), "rc-vid-"));
  try {
    const videoPath = join(dir, "video.mp4");
    if (!(await downloadMedia(url, videoPath, fetchFn))) return null;

    const dur = await durationFn(videoPath);
    if (dur !== null && dur > MAX_VIDEO_DURATION_SEC) return null;

    let transcripcion = "";
    try {
      const audioPath = join(dir, "audio.wav");
      await runFfmpeg(["-y", "-i", videoPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", audioPath], dir);
      transcripcion = (await transcribeAudio(audioPath, "es", process.env.ELEVENLABS_API_KEY)).trim();
    } catch {
      transcripcion = "";
    }

    const frames: string[] = [];
    try {
      // Muestreo parejo: maxFrames repartidos a lo largo de toda la duración. Sin duración
      // conocida, 1 frame cada 2s como aproximación conservadora.
      const fps = dur && dur > 0 ? Math.max(maxFrames / dur, 0.01) : 0.5;
      await runFfmpeg(
        ["-y", "-i", videoPath, "-vf", `fps=${fps.toFixed(4)}`, "-frames:v", String(maxFrames), join(dir, "frame_%02d.jpg")],
        dir,
      );
      const files = (await readdir(dir)).filter((f) => f.startsWith("frame_")).sort().slice(0, maxFrames);
      for (const f of files) {
        try {
          const a = await analyzePhoto({ imagePath: join(dir, f), task: "describe" });
          if (a.text.trim()) frames.push(a.text.trim());
        } catch {
          // Un frame que falla no corta los demás.
        }
      }
    } catch {
      // Sin frames: si hay transcripción, igual sirve.
    }

    if (!transcripcion && frames.length === 0) return null;
    return { transcripcion, frames };
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-media.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck y commit**

```bash
cd daemon-v2 && npx tsc --noEmit
git add daemon-v2/src/tools/research-competencia-media.ts daemon-v2/src/tools/research-competencia-media.test.ts
git commit -m "feat(research-competencia): análisis de video con transcripción y frames"
```

---

### Task 3: Tipos sociales, filtro de timeframe y formateo a texto

**Files:**
- Create: `daemon-v2/src/tools/research-competencia-social.ts`
- Test: `daemon-v2/src/tools/research-competencia-social.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { describe, it, expect } from "vitest";
import { filterPostsByTimeframe, formatSocialText, type SocialPost, type EnrichedPost } from "./research-competencia-social.js";

function post(overrides: Partial<SocialPost> = {}): SocialPost {
  return {
    platform: "instagram", handle: "altoke.bo", url: "https://instagram.com/p/abc",
    fecha: "2026-09-01", caption: "Nueva promo", mediaUrls: [], esVideo: false,
    ...overrides,
  };
}

describe("filterPostsByTimeframe", () => {
  const ahora = new Date("2026-09-10T12:00:00Z");

  it("deja pasar un post dentro de la ventana", () => {
    expect(filterPostsByTimeframe([post({ fecha: "2026-09-08" })], 7, ahora)).toHaveLength(1);
  });

  it("descarta un post anterior a la ventana", () => {
    expect(filterPostsByTimeframe([post({ fecha: "2026-08-01" })], 7, ahora)).toHaveLength(0);
  });

  it("conserva posts sin fecha — mejor procesarlos que perder contenido reciente sin timestamp legible", () => {
    expect(filterPostsByTimeframe([post({ fecha: null })], 7, ahora)).toHaveLength(1);
  });
});

describe("formatSocialText", () => {
  it("incluye plataforma, handle, URL, caption, descripción de imagen y transcripción", () => {
    const enriched: EnrichedPost[] = [{
      ...post({ esVideo: true }),
      imagenes: ["Flyer con tarifa 0%"],
      video: { transcripcion: "Ahora podés pedir tu crédito", frames: ["Pantalla de la app con Bs 800"] },
    }];
    const text = formatSocialText(enriched);
    expect(text).toContain("instagram");
    expect(text).toContain("altoke.bo");
    expect(text).toContain("https://instagram.com/p/abc");
    expect(text).toContain("Nueva promo");
    expect(text).toContain("Flyer con tarifa 0%");
    expect(text).toContain("Ahora podés pedir tu crédito");
    expect(text).toContain("Pantalla de la app con Bs 800");
  });

  it("devuelve string vacío si no hay posts", () => {
    expect(formatSocialText([])).toBe("");
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-social.test.ts`
Expected: FAIL — "Failed to resolve import ./research-competencia-social.js"

- [ ] **Step 3: Implementar**

```typescript
import type { VideoAnalysis } from "./research-competencia-media.js";

export type SocialPlatform = "instagram" | "tiktok" | "facebook" | "x";

export interface SocialPost {
  platform: SocialPlatform;
  handle: string;
  /** Permalink del post — se usa como `fuente` citable en hallazgos y battlecard. */
  url: string;
  /** ISO date (YYYY-MM-DD) si se pudo extraer; null si la plataforma no la expone legible. */
  fecha: string | null;
  caption: string;
  mediaUrls: string[];
  esVideo: boolean;
}

export interface EnrichedPost extends SocialPost {
  /** Descripciones de visión de las imágenes del post. */
  imagenes: string[];
  video?: VideoAnalysis;
}

/**
 * Deja solo los posts dentro de la ventana. Los posts SIN fecha se conservan a propósito:
 * las 4 plataformas a veces muestran fechas relativas ilegibles ("2 d") o directamente las
 * ocultan, y descartarlos perdería contenido reciente. El agente ya sabe ignorar lo viejo.
 */
export function filterPostsByTimeframe(posts: SocialPost[], timeframeDias: number, ahora = new Date()): SocialPost[] {
  const desde = new Date(ahora.getTime() - timeframeDias * 24 * 60 * 60 * 1000);
  return posts.filter((p) => {
    if (!p.fecha) return true;
    const d = new Date(p.fecha);
    return Number.isNaN(d.getTime()) ? true : d >= desde;
  });
}

/** Consolida los posts enriquecidos a un bloque de texto para el prompt del agente. */
export function formatSocialText(posts: EnrichedPost[]): string {
  if (posts.length === 0) return "";
  const bloques = posts.map((p) => {
    const lineas = [`[${p.platform} @${p.handle}${p.fecha ? ` · ${p.fecha}` : ""}] ${p.url}`];
    if (p.caption) lineas.push(`Caption: ${p.caption}`);
    for (const img of p.imagenes) lineas.push(`Imagen: ${img}`);
    if (p.video?.transcripcion) lineas.push(`Transcripción del video: ${p.video.transcripcion}`);
    for (const f of p.video?.frames ?? []) lineas.push(`Frame del video: ${f}`);
    return lineas.join("\n");
  });
  return bloques.join("\n\n");
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-social.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Typecheck y commit**

```bash
cd daemon-v2 && npx tsc --noEmit
git add daemon-v2/src/tools/research-competencia-social.ts daemon-v2/src/tools/research-competencia-social.test.ts
git commit -m "feat(research-competencia): tipos sociales, filtro de timeframe y formateo a texto"
```

---

### Task 4: Scraper de Instagram

**Files:**
- Modify: `daemon-v2/src/tools/research-competencia-social.ts`
- Test: `daemon-v2/src/tools/research-competencia-social.test.ts`

**Contexto para el implementador:** Instagram embebe los posts del perfil en un JSON dentro del HTML. El parseo se testea con un fixture; la navegación con Playwright se verifica en vivo en la Task 13. La función de scraping sigue el patrón exacto de `daemon-v2/src/tools/design-capture.ts` (chromium headless in-process, `context.addCookies(cookies)` con cookies que vienen de `getStructuredCookies()` de `cookie-jar.ts` — el formato ya trae `domain` con punto inicial y `path`).

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { parseInstagramPosts } from "./research-competencia-social.js";

describe("parseInstagramPosts", () => {
  it("extrae caption, url, fecha y media de los nodos del perfil", () => {
    const nodos = [
      {
        shortcode: "ABC123",
        taken_at_timestamp: 1788307200, // 2026-09-01
        is_video: false,
        display_url: "https://cdn.instagram.com/foto.jpg",
        edge_media_to_caption: { edges: [{ node: { text: "Promo 2x1 en altoke" } }] },
      },
      {
        shortcode: "DEF456",
        taken_at_timestamp: 1788393600,
        is_video: true,
        video_url: "https://cdn.instagram.com/reel.mp4",
        display_url: "https://cdn.instagram.com/thumb.jpg",
        edge_media_to_caption: { edges: [] },
      },
    ];

    const posts = parseInstagramPosts(nodos, "altoke.bo");

    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({
      platform: "instagram",
      handle: "altoke.bo",
      url: "https://www.instagram.com/p/ABC123/",
      caption: "Promo 2x1 en altoke",
      esVideo: false,
      mediaUrls: ["https://cdn.instagram.com/foto.jpg"],
    });
    expect(posts[0].fecha).toBe("2026-09-01");
    expect(posts[1].esVideo).toBe(true);
    expect(posts[1].mediaUrls).toEqual(["https://cdn.instagram.com/reel.mp4"]);
    expect(posts[1].caption).toBe("");
  });

  it("ignora nodos sin shortcode en vez de romper", () => {
    expect(parseInstagramPosts([{ is_video: false }], "altoke.bo")).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-social.test.ts`
Expected: FAIL — "parseInstagramPosts is not a function"

- [ ] **Step 3: Implementar**

Agregar a `research-competencia-social.ts`:

```typescript
import { chromium } from "playwright";
import type { StructuredCookie } from "./cookie-jar.js";

/** Timestamp Unix (segundos) a YYYY-MM-DD. null si no es un número usable. */
function isoDateFromUnix(ts: unknown): string | null {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function parseInstagramPosts(nodos: unknown[], handle: string): SocialPost[] {
  const posts: SocialPost[] = [];
  for (const raw of nodos) {
    const n = raw as {
      shortcode?: string; taken_at_timestamp?: number; is_video?: boolean;
      display_url?: string; video_url?: string;
      edge_media_to_caption?: { edges?: Array<{ node?: { text?: string } }> };
    };
    if (!n.shortcode) continue;
    const esVideo = n.is_video === true;
    const media = esVideo ? n.video_url : n.display_url;
    posts.push({
      platform: "instagram",
      handle,
      url: `https://www.instagram.com/p/${n.shortcode}/`,
      fecha: isoDateFromUnix(n.taken_at_timestamp),
      caption: n.edge_media_to_caption?.edges?.[0]?.node?.text ?? "",
      mediaUrls: media ? [media] : [],
      esVideo,
    });
  }
  return posts;
}

/**
 * Abre el perfil de Instagram con las cookies del Cookie Broker y devuelve sus posts recientes.
 * Una sola visita, sin scroll — minimiza la huella de automatización sobre la cuenta que presta
 * las cookies (ver riesgos del spec). Devuelve [] ante cualquier falla: nunca tira.
 */
export async function scrapeInstagram(handle: string, cookies: StructuredCookie[]): Promise<SocialPost[]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    if (cookies.length > 0) await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: "networkidle", timeout: 30_000 });

    const nodos = await page.evaluate(() => {
      // Instagram deja el timeline en window.__additionalDataLoaded o en un <script> con JSON.
      // Se recorre el objeto buscando la colección de posts sin depender de la ruta exacta,
      // que cambia seguido entre despliegues.
      const encontrados: unknown[] = [];
      const visitar = (valor: unknown, profundidad: number): void => {
        if (profundidad > 8 || !valor || typeof valor !== "object") return;
        const obj = valor as Record<string, unknown>;
        if (typeof obj.shortcode === "string" && "is_video" in obj) {
          encontrados.push(obj);
          return;
        }
        for (const v of Object.values(obj)) visitar(v, profundidad + 1);
      };
      for (const script of Array.from(document.querySelectorAll("script"))) {
        const txt = script.textContent ?? "";
        if (!txt.includes("shortcode")) continue;
        const inicio = txt.indexOf("{");
        if (inicio < 0) continue;
        try {
          visitar(JSON.parse(txt.slice(inicio)), 0);
        } catch {
          // Script que no es JSON puro — se ignora.
        }
      }
      return encontrados;
    });

    return parseInstagramPosts(nodos, handle);
  } catch {
    return [];
  } finally {
    await browser.close();
  }
}
```

Nota para el implementador: `page.evaluate` corre en el navegador, no en Node. `design-capture.ts` resuelve los tipos del DOM declarando localmente lo que usa (ver el bloque `declare const document` en ese archivo) en vez de agregar `"DOM"` al `lib` del tsconfig — replicar ese enfoque acá, declarando `document.querySelectorAll("script")` con `textContent`.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-social.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck y commit**

```bash
cd daemon-v2 && npx tsc --noEmit
git add daemon-v2/src/tools/research-competencia-social.ts daemon-v2/src/tools/research-competencia-social.test.ts
git commit -m "feat(research-competencia): scraper de Instagram"
```

---

### Task 5: Scraper de TikTok

**Files:**
- Modify: `daemon-v2/src/tools/research-competencia-social.ts`
- Test: `daemon-v2/src/tools/research-competencia-social.test.ts`

**Contexto:** TikTok publica el estado del perfil en `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">`. Todo post de TikTok es video.

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { parseTikTokPosts } from "./research-competencia-social.js";

describe("parseTikTokPosts", () => {
  it("extrae descripción, url, fecha y video", () => {
    const items = [{
      id: "7500000000000000000",
      desc: "Así funciona el QR delegado",
      createTime: 1788307200,
      video: { playAddr: "https://cdn.tiktok.com/v.mp4" },
    }];

    const posts = parseTikTokPosts(items, "altoke.bo");

    expect(posts[0]).toMatchObject({
      platform: "tiktok",
      handle: "altoke.bo",
      url: "https://www.tiktok.com/@altoke.bo/video/7500000000000000000",
      caption: "Así funciona el QR delegado",
      esVideo: true,
      mediaUrls: ["https://cdn.tiktok.com/v.mp4"],
    });
    expect(posts[0].fecha).toBe("2026-09-01");
  });

  it("ignora items sin id", () => {
    expect(parseTikTokPosts([{ desc: "x" }], "altoke.bo")).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-social.test.ts`
Expected: FAIL — "parseTikTokPosts is not a function"

- [ ] **Step 3: Implementar**

```typescript
export function parseTikTokPosts(items: unknown[], handle: string): SocialPost[] {
  const posts: SocialPost[] = [];
  for (const raw of items) {
    const n = raw as { id?: string; desc?: string; createTime?: number; video?: { playAddr?: string } };
    if (!n.id) continue;
    posts.push({
      platform: "tiktok",
      handle,
      url: `https://www.tiktok.com/@${handle}/video/${n.id}`,
      fecha: isoDateFromUnix(n.createTime),
      caption: n.desc ?? "",
      mediaUrls: n.video?.playAddr ? [n.video.playAddr] : [],
      esVideo: true,
    });
  }
  return posts;
}

/**
 * Perfil de TikTok vía el JSON de rehidratación que la página deja en un <script>.
 * TikTok detecta automatización más agresivo que Instagram: si devuelve [] de forma
 * sistemática, es bloqueo de plataforma, no un bug del parser (ver riesgos del spec).
 */
export async function scrapeTikTok(handle: string, cookies: StructuredCookie[]): Promise<SocialPost[]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    if (cookies.length > 0) await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto(`https://www.tiktok.com/@${handle}`, { waitUntil: "networkidle", timeout: 30_000 });

    const items = await page.evaluate(() => {
      const script = document.querySelector("#__UNIVERSAL_DATA_FOR_REHYDRATION__");
      if (!script?.textContent) return [];
      const encontrados: unknown[] = [];
      const visitar = (valor: unknown, profundidad: number): void => {
        if (profundidad > 8 || !valor || typeof valor !== "object") return;
        const obj = valor as Record<string, unknown>;
        if (typeof obj.id === "string" && "desc" in obj && "video" in obj) {
          encontrados.push(obj);
          return;
        }
        for (const v of Object.values(obj)) visitar(v, profundidad + 1);
      };
      try {
        visitar(JSON.parse(script.textContent), 0);
      } catch {
        return [];
      }
      return encontrados;
    });

    return parseTikTokPosts(items, handle);
  } catch {
    return [];
  } finally {
    await browser.close();
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-social.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Typecheck y commit**

```bash
cd daemon-v2 && npx tsc --noEmit
git add daemon-v2/src/tools/research-competencia-social.ts daemon-v2/src/tools/research-competencia-social.test.ts
git commit -m "feat(research-competencia): scraper de TikTok"
```

---

### Task 6: Scrapers de Facebook y X

**Files:**
- Modify: `daemon-v2/src/tools/research-competencia-social.ts`
- Test: `daemon-v2/src/tools/research-competencia-social.test.ts`

**Contexto:** Facebook y X no exponen un JSON estable como IG/TikTok, así que ambos se leen del DOM ya renderizado. Se extraen del DOM en el browser y se normalizan en una función pura testeable (`parseDomPosts`), compartida por las dos plataformas.

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { parseDomPosts, type RawDomPost } from "./research-competencia-social.js";

describe("parseDomPosts", () => {
  it("normaliza posts crudos del DOM a SocialPost", () => {
    const crudos: RawDomPost[] = [{
      url: "https://x.com/bancosol/status/123",
      texto: "Nueva campaña de ahorro",
      fechaIso: "2026-09-01T10:00:00.000Z",
      imagenes: ["https://pbs.twimg.com/media/a.jpg"],
      videos: [],
    }];

    const posts = parseDomPosts(crudos, "x", "bancosol");

    expect(posts[0]).toMatchObject({
      platform: "x",
      handle: "bancosol",
      url: "https://x.com/bancosol/status/123",
      fecha: "2026-09-01",
      caption: "Nueva campaña de ahorro",
      mediaUrls: ["https://pbs.twimg.com/media/a.jpg"],
      esVideo: false,
    });
  });

  it("marca esVideo y prioriza la URL de video sobre la imagen", () => {
    const crudos: RawDomPost[] = [{
      url: "https://facebook.com/altoke.bo/posts/1",
      texto: "Mirá cómo funciona",
      fechaIso: null,
      imagenes: ["https://cdn/thumb.jpg"],
      videos: ["https://cdn/video.mp4"],
    }];

    const posts = parseDomPosts(crudos, "facebook", "altoke.bo");

    expect(posts[0].esVideo).toBe(true);
    expect(posts[0].mediaUrls).toEqual(["https://cdn/video.mp4"]);
    expect(posts[0].fecha).toBeNull();
  });

  it("descarta posts sin url", () => {
    const crudos = [{ url: "", texto: "x", fechaIso: null, imagenes: [], videos: [] }] as RawDomPost[];
    expect(parseDomPosts(crudos, "facebook", "x")).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-social.test.ts`
Expected: FAIL — "parseDomPosts is not a function"

- [ ] **Step 3: Implementar**

```typescript
export interface RawDomPost {
  url: string;
  texto: string;
  fechaIso: string | null;
  imagenes: string[];
  videos: string[];
}

export function parseDomPosts(crudos: RawDomPost[], platform: SocialPlatform, handle: string): SocialPost[] {
  const posts: SocialPost[] = [];
  for (const c of crudos) {
    if (!c.url) continue;
    const esVideo = c.videos.length > 0;
    const fecha = c.fechaIso && !Number.isNaN(new Date(c.fechaIso).getTime()) ? c.fechaIso.slice(0, 10) : null;
    posts.push({
      platform,
      handle,
      url: c.url,
      fecha,
      caption: c.texto,
      mediaUrls: esVideo ? c.videos.slice(0, 1) : c.imagenes.slice(0, 1),
      esVideo,
    });
  }
  return posts;
}

/** Extrae posts del DOM ya renderizado. Compartido por Facebook y X, que no exponen JSON estable. */
async function scrapeDom(url: string, platform: SocialPlatform, handle: string, cookies: StructuredCookie[]): Promise<SocialPost[]> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    if (cookies.length > 0) await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

    const crudos = await page.evaluate(() => {
      // `article` cubre los dos: X marca cada tweet como <article>, y Facebook usa
      // role="article" en cada post del feed de la página.
      const nodos = Array.from(document.querySelectorAll('article, [role="article"]'));
      return nodos.map((nodo) => {
        const link = nodo.querySelector('a[href*="/status/"], a[href*="/posts/"], a[href*="/videos/"]');
        const time = nodo.querySelector("time");
        return {
          url: link ? (link as { href?: string }).href ?? "" : "",
          texto: (nodo.textContent ?? "").trim().slice(0, 2000),
          fechaIso: time ? (time as { dateTime?: string }).dateTime ?? null : null,
          imagenes: Array.from(nodo.querySelectorAll("img"))
            .map((i) => (i as { src?: string }).src ?? "")
            .filter((s) => s.startsWith("http")),
          videos: Array.from(nodo.querySelectorAll("video"))
            .map((v) => (v as { src?: string }).src ?? "")
            .filter((s) => s.startsWith("http")),
        };
      });
    });

    return parseDomPosts(crudos as RawDomPost[], platform, handle);
  } catch {
    return [];
  } finally {
    await browser.close();
  }
}

export async function scrapeFacebook(handle: string, cookies: StructuredCookie[]): Promise<SocialPost[]> {
  return scrapeDom(`https://www.facebook.com/${handle}`, "facebook", handle, cookies);
}

export async function scrapeX(handle: string, cookies: StructuredCookie[]): Promise<SocialPost[]> {
  return scrapeDom(`https://x.com/${handle}`, "x", handle, cookies);
}
```

Nota: extender el bloque de declaraciones locales del DOM (patrón de `design-capture.ts`) para cubrir `querySelector`, `querySelectorAll("img"|"video"|"time")`, `textContent` y `href`/`src`/`dateTime`.

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-social.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Typecheck y commit**

```bash
cd daemon-v2 && npx tsc --noEmit
git add daemon-v2/src/tools/research-competencia-social.ts daemon-v2/src/tools/research-competencia-social.test.ts
git commit -m "feat(research-competencia): scrapers de Facebook y X"
```

---

### Task 7: Enriquecimiento multimodal con topes por cuenta

**Files:**
- Modify: `daemon-v2/src/tools/research-competencia-social.ts`
- Test: `daemon-v2/src/tools/research-competencia-social.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { enrichPosts, MAX_POSTS_PER_ACCOUNT, MAX_VIDEOS_PER_ACCOUNT } from "./research-competencia-social.js";

describe("enrichPosts", () => {
  const deps = {
    describeImageFn: async () => "Descripción de imagen",
    analyzeVideoFn: async () => ({ transcripcion: "Audio del video", frames: ["Frame 1"] }),
  };

  it("aplica el tope de posts por cuenta", async () => {
    const posts = Array.from({ length: MAX_POSTS_PER_ACCOUNT + 5 }, (_, i) =>
      post({ url: `https://instagram.com/p/${i}`, mediaUrls: ["https://cdn/x.jpg"] }));
    const enriched = await enrichPosts(posts, deps);
    expect(enriched).toHaveLength(MAX_POSTS_PER_ACCOUNT);
  });

  it("aplica el tope de videos por cuenta — los que sobran quedan sin análisis de video", async () => {
    const posts = Array.from({ length: MAX_POSTS_PER_ACCOUNT }, (_, i) =>
      post({ url: `https://instagram.com/p/${i}`, esVideo: true, mediaUrls: ["https://cdn/v.mp4"] }));
    const enriched = await enrichPosts(posts, deps);
    expect(enriched.filter((p) => p.video).length).toBe(MAX_VIDEOS_PER_ACCOUNT);
  });

  it("enriquece imágenes con visión", async () => {
    const enriched = await enrichPosts([post({ mediaUrls: ["https://cdn/x.jpg"] })], deps);
    expect(enriched[0].imagenes).toEqual(["Descripción de imagen"]);
  });

  it("un post cuyo análisis tira no corta los demás", async () => {
    const posts = [
      post({ url: "https://instagram.com/p/1", mediaUrls: ["https://cdn/roto.jpg"] }),
      post({ url: "https://instagram.com/p/2", mediaUrls: ["https://cdn/ok.jpg"] }),
    ];
    const describeImageFn = async (url: string) => {
      if (url.includes("roto")) throw new Error("boom");
      return "Descripción de imagen";
    };
    const enriched = await enrichPosts(posts, { ...deps, describeImageFn });
    expect(enriched).toHaveLength(2);
    expect(enriched[0].imagenes).toEqual([]);
    expect(enriched[1].imagenes).toEqual(["Descripción de imagen"]);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-social.test.ts`
Expected: FAIL — "enrichPosts is not a function"

- [ ] **Step 3: Implementar**

```typescript
import { describeImage, analyzeVideo } from "./research-competencia-media.js";

export const MAX_POSTS_PER_ACCOUNT = 8;
export const MAX_VIDEOS_PER_ACCOUNT = 4;

export interface EnrichDeps {
  describeImageFn?: (url: string) => Promise<string | null>;
  analyzeVideoFn?: (url: string) => Promise<VideoAnalysis | null>;
}

/**
 * Descarga y analiza la media de los posts, respetando los topes por cuenta del spec.
 * Los videos que exceden MAX_VIDEOS_PER_ACCOUNT se conservan como post (caption incluido)
 * pero sin análisis de video — el caption sigue teniendo valor.
 */
export async function enrichPosts(posts: SocialPost[], deps: EnrichDeps = {}): Promise<EnrichedPost[]> {
  const describeImageFn = deps.describeImageFn ?? describeImage;
  const analyzeVideoFn = deps.analyzeVideoFn ?? analyzeVideo;

  const acotados = posts.slice(0, MAX_POSTS_PER_ACCOUNT);
  const enriched: EnrichedPost[] = [];
  let videosAnalizados = 0;

  for (const p of acotados) {
    const item: EnrichedPost = { ...p, imagenes: [] };
    try {
      if (p.esVideo) {
        if (videosAnalizados < MAX_VIDEOS_PER_ACCOUNT && p.mediaUrls[0]) {
          const analisis = await analyzeVideoFn(p.mediaUrls[0]);
          if (analisis) item.video = analisis;
          videosAnalizados++;
        }
      } else {
        for (const url of p.mediaUrls) {
          const desc = await describeImageFn(url);
          if (desc) item.imagenes.push(desc);
        }
      }
    } catch {
      // Un post cuyo análisis falla se conserva igual (caption + URL siguen sirviendo).
    }
    enriched.push(item);
  }
  return enriched;
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-social.test.ts`
Expected: PASS (16 tests)

- [ ] **Step 5: Typecheck y commit**

```bash
cd daemon-v2 && npx tsc --noEmit
git add daemon-v2/src/tools/research-competencia-social.ts daemon-v2/src/tools/research-competencia-social.test.ts
git commit -m "feat(research-competencia): enriquecimiento multimodal con topes por cuenta"
```

---

### Task 8: Handles sociales en la config de entidades

**Files:**
- Modify: `daemon-v2/src/tools/research-competencia-entities.ts`
- Test: `daemon-v2/src/tools/research-competencia-entities.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { ENTITIES, getEntity } from "./research-competencia-entities.js";

describe("handles sociales", () => {
  it("altoke tiene las 2 cuentas de Instagram (billetera y banco) y su TikTok", () => {
    const e = getEntity("bancosol-altoke");
    expect(e.social?.instagram).toEqual(["altoke.bo", "bancosol_bolivia"]);
    expect(e.social?.tiktok).toEqual(["altoke.bo"]);
    expect(e.social?.x).toEqual(["bancosol"]);
  });

  it("toda entidad tiene al menos una cuenta de Instagram", () => {
    for (const e of ENTITIES) {
      expect(e.social?.instagram?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("las entidades sin cuenta confirmada en una plataforma no la declaran", () => {
    expect(getEntity("peso-app").social?.x ?? []).toEqual([]);
    expect(getEntity("takenos").social?.facebook ?? []).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-entities.test.ts`
Expected: FAIL — "Cannot read properties of undefined (reading 'instagram')"

- [ ] **Step 3: Implementar**

En `research-competencia-entities.ts`, extender la interfaz y cada entidad:

```typescript
export interface SocialHandles {
  instagram?: string[];
  tiktok?: string[];
  facebook?: string[];
  x?: string[];
}

export interface EntityConfig {
  id: string;
  nombre: string;
  ios?: { trackId?: string; searchTerm?: string };
  android?: { packageName: string };
  siteUrl?: string;
  linkedinQuery: string;
  // Handles verificados por búsqueda web el 2026-09-02 (ver spec de Fase 2). Una plataforma
  // sin cuenta oficial confirmada simplemente no se declara — no se inventa un handle.
  social?: SocialHandles;
}
```

Agregar a cada entidad del array `ENTITIES`:

```typescript
// bancosol-altoke
social: {
  instagram: ["altoke.bo", "bancosol_bolivia"],
  tiktok: ["altoke.bo"],
  facebook: ["altoke.bo", "BancoSolidarioBolivia"],
  x: ["bancosol"],
},

// ganadero-yolopago
social: {
  instagram: ["yolopagoapp", "bancoganadero"],
  tiktok: ["yolopagoapp"],
  facebook: ["YoloPagoApp", "bg.com.bo"],
  x: ["yolo_pago"],
},

// economico-zas
social: {
  instagram: ["banco.economico"],
  facebook: ["banco.economico"],
},

// takenos
social: {
  instagram: ["takenosapp.bo"],
  tiktok: ["takenos_app_bo"],
  x: ["takenosapp"],
},

// meru
social: {
  instagram: ["meru.app"],
  facebook: ["getmeruapp"],
  x: ["getmeru"],
},

// peso-app
social: {
  instagram: ["peso.latam"],
  tiktok: ["peso.latam"],
},
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-entities.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck y commit**

```bash
cd daemon-v2 && npx tsc --noEmit
git add daemon-v2/src/tools/research-competencia-entities.ts daemon-v2/src/tools/research-competencia-entities.test.ts
git commit -m "feat(research-competencia): handles de RRSS por entidad"
```

---

### Task 9: Fetch social por entidad (dispatcher)

**Files:**
- Modify: `daemon-v2/src/tools/research-competencia-social.ts`
- Test: `daemon-v2/src/tools/research-competencia-social.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { fetchSocialText } from "./research-competencia-social.js";
import { getEntity } from "./research-competencia-entities.js";

describe("fetchSocialText", () => {
  const scrapersOk = {
    instagram: async (h: string) => [post({ platform: "instagram", handle: h, caption: `IG de ${h}` })],
    tiktok: async (h: string) => [post({ platform: "tiktok", handle: h, caption: `TikTok de ${h}` })],
    facebook: async (h: string) => [post({ platform: "facebook", handle: h, caption: `FB de ${h}` })],
    x: async (h: string) => [post({ platform: "x", handle: h, caption: `X de ${h}` })],
  };
  const deps = {
    scrapers: scrapersOk,
    getCookies: async () => [],
    enrichFn: async (posts: SocialPost[]) => posts.map((p) => ({ ...p, imagenes: [] })),
  };

  it("recorre todas las plataformas y handles declarados de la entidad", async () => {
    const text = await fetchSocialText(getEntity("bancosol-altoke"), 7, deps);
    expect(text).toContain("IG de altoke.bo");
    expect(text).toContain("IG de bancosol_bolivia");
    expect(text).toContain("TikTok de altoke.bo");
    expect(text).toContain("X de bancosol");
  });

  it("una plataforma que falla no corta las demás", async () => {
    const scrapers = { ...scrapersOk, tiktok: async () => { throw new Error("bloqueado"); } };
    const text = await fetchSocialText(getEntity("bancosol-altoke"), 7, { ...deps, scrapers });
    expect(text).toContain("IG de altoke.bo");
    expect(text).not.toContain("TikTok");
  });

  it("devuelve null si la entidad no declara ninguna cuenta", async () => {
    const sinSocial = { ...getEntity("meru"), social: undefined };
    expect(await fetchSocialText(sinSocial, 7, deps)).toBeNull();
  });

  it("devuelve null si ninguna plataforma trajo posts", async () => {
    const scrapers = { instagram: async () => [], tiktok: async () => [], facebook: async () => [], x: async () => [] };
    expect(await fetchSocialText(getEntity("takenos"), 7, { ...deps, scrapers })).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-social.test.ts`
Expected: FAIL — "fetchSocialText is not a function"

- [ ] **Step 3: Implementar**

```typescript
import type { EntityConfig } from "./research-competencia-entities.js";

export type ScraperFn = (handle: string, cookies: StructuredCookie[]) => Promise<SocialPost[]>;

export interface FetchSocialDeps {
  scrapers?: Record<SocialPlatform, ScraperFn>;
  getCookies?: (hostname: string) => Promise<StructuredCookie[]>;
  enrichFn?: (posts: SocialPost[]) => Promise<EnrichedPost[]>;
  ahora?: Date;
}

const DEFAULT_SCRAPERS: Record<SocialPlatform, ScraperFn> = {
  instagram: scrapeInstagram,
  tiktok: scrapeTikTok,
  facebook: scrapeFacebook,
  x: scrapeX,
};

const HOSTNAMES: Record<SocialPlatform, string> = {
  instagram: "instagram.com",
  tiktok: "tiktok.com",
  facebook: "facebook.com",
  x: "x.com",
};

/**
 * Recorre todas las plataformas y handles declarados de una entidad, aplica el filtro de
 * timeframe, enriquece la media y devuelve un bloque de texto listo para el prompt.
 * Aislamiento por cuenta: una plataforma bloqueada o un handle caído no cortan al resto.
 * Devuelve null si la entidad no declara cuentas o si nada trajo contenido.
 */
export async function fetchSocialText(
  entity: EntityConfig,
  timeframeDias: number,
  deps: FetchSocialDeps = {},
): Promise<string | null> {
  if (!entity.social) return null;
  const scrapers = deps.scrapers ?? DEFAULT_SCRAPERS;
  const getCookies = deps.getCookies ?? (async () => []);
  const enrichFn = deps.enrichFn ?? ((posts: SocialPost[]) => enrichPosts(posts));

  const todos: EnrichedPost[] = [];
  for (const platform of Object.keys(HOSTNAMES) as SocialPlatform[]) {
    const handles = entity.social[platform] ?? [];
    for (const handle of handles) {
      try {
        const cookies = await getCookies(HOSTNAMES[platform]);
        const posts = await scrapers[platform](handle, cookies);
        const enVentana = filterPostsByTimeframe(posts, timeframeDias, deps.ahora);
        todos.push(...(await enrichFn(enVentana)));
      } catch {
        // Cuenta bloqueada, markup cambiado o timeout: sigue con las demás cuentas.
      }
    }
  }

  const texto = formatSocialText(todos);
  return texto || null;
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-social.test.ts`
Expected: PASS (20 tests)

- [ ] **Step 5: Typecheck y commit**

```bash
cd daemon-v2 && npx tsc --noEmit
git add daemon-v2/src/tools/research-competencia-social.ts daemon-v2/src/tools/research-competencia-social.test.ts
git commit -m "feat(research-competencia): dispatcher social por entidad"
```

---

### Task 10: Cablear socialText en el orquestador

**Files:**
- Modify: `daemon-v2/src/tools/research-competencia.ts`
- Modify: `daemon-v2/src/tools/research-competencia-agent.ts`
- Test: `daemon-v2/src/tools/research-competencia.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Agregar el mock de social arriba del archivo, junto a los otros `vi.mock`:

```typescript
vi.mock("./research-competencia-social.js", () => ({
  fetchSocialText: vi.fn(async () => "[instagram @altoke.bo] Promo nueva"),
}));
```

Y el test:

```typescript
import { fetchSocialText } from "./research-competencia-social.js";
import { buildEntityPrompt } from "./research-competencia-agent.js";

it("pasa el texto de RRSS al prompt del agente", async () => {
  await runResearchCompetencia({ entidadIds: ["takenos"] });
  const facts = vi.mocked(buildEntityPrompt).mock.calls[0][2];
  expect(facts.socialText).toBe("[instagram @altoke.bo] Promo nueva");
});

it("una falla del scraping social no corta la corrida de la entidad", async () => {
  vi.mocked(fetchSocialText).mockRejectedValueOnce(new Error("boom"));
  const result = await runResearchCompetencia({ entidadIds: ["takenos"] });
  expect(result.entidades[0].error).toBeUndefined();
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia.test.ts`
Expected: FAIL — `facts.socialText` es `undefined`

- [ ] **Step 3: Implementar**

En `research-competencia-agent.ts`, extender `MechanicalFacts`:

```typescript
export interface MechanicalFacts {
  ios: { version: string; rating: number | null; releaseNotes: string | null } | null;
  android: { version: string | null; rating: number | null; releaseNotes: string | null } | null;
  siteText: string | null;
  socialText: string | null;
}
```

En `research-competencia.ts`, sumar el fetch social al `Promise.all` y a los facts:

```typescript
import { fetchSocialText } from "./research-competencia-social.js";

// dentro del try por entidad, reemplazando el Promise.all actual:
const [ios, android, siteText, socialText] = await Promise.all([
  entity.ios ? fetchIosAppInfo(entity.ios) : Promise.resolve(null),
  entity.android ? fetchAndroidAppInfo(entity.android.packageName) : Promise.resolve(null),
  entity.siteUrl ? fetchSiteText(entity.siteUrl) : Promise.resolve(null),
  // El scraping social no debe poder tumbar la entidad: si tira, se sigue con las demás fuentes.
  fetchSocialText(entity, timeframeDias, { getCookies: opts.getCookies }).catch(() => null),
]);
const facts: MechanicalFacts = {
  ios: ios ? { version: ios.version, rating: ios.rating, releaseNotes: ios.releaseNotes } : null,
  android: android ? { version: android.version, rating: android.rating, releaseNotes: android.releaseNotes } : null,
  siteText,
  socialText,
};
```

Y extender `RunOpts` para poder inyectar el proveedor de cookies:

```typescript
import type { StructuredCookie } from "./cookie-jar.js";

export interface RunOpts {
  timeframeDias?: number;
  entidadIds?: string[];
  /** Proveedor de cookies del Cookie Broker. Sin él, el scraping social corre sin sesión. */
  getCookies?: (hostname: string) => Promise<StructuredCookie[]>;
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck y commit**

```bash
cd daemon-v2 && npx tsc --noEmit
git add daemon-v2/src/tools/research-competencia.ts daemon-v2/src/tools/research-competencia-agent.ts daemon-v2/src/tools/research-competencia.test.ts
git commit -m "feat(research-competencia): cablear RRSS al orquestador"
```

---

### Task 11: El prompt reconoce RRSS como fuente citable

**Files:**
- Modify: `daemon-v2/src/tools/research-competencia-agent.ts`
- Test: `daemon-v2/src/tools/research-competencia-agent.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
it("incluye el texto de RRSS en el prompt y lo declara como fuente citable", () => {
  const entity = getEntity("takenos");
  const prompt = buildEntityPrompt(
    entity, null,
    { ios: null, android: null, siteText: null, socialText: "[instagram @takenosapp.bo · 2026-09-01] https://instagram.com/p/x\nCaption: Promo nueva" },
    7,
  );
  expect(prompt).toContain("Promo nueva");
  expect(prompt).toContain("redes sociales");
  expect(prompt).toContain("URL del post");
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-agent.test.ts`
Expected: FAIL — el prompt no menciona "redes sociales"

- [ ] **Step 3: Implementar**

En `buildEntityPrompt`, después de la línea de datos mecánicos, insertar:

```typescript
    ``,
    `Contenido de las redes sociales oficiales de la entidad en la ventana (Instagram, TikTok, Facebook, X). Incluye el caption del post, la descripción de las imágenes, y para videos la transcripción del audio y la lectura de sus frames — ahí suelen estar las tarifas, condiciones y promos que no aparecen en ningún otro lado:`,
    facts.socialText ?? "(sin contenido de redes sociales en esta corrida)",
    ``,
    `Un hallazgo que salga de un post lleva como "fuente" la URL del post (viene en el encabezado de cada bloque) — es una fuente citable válida, igual que una nota de prensa.`,
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `cd daemon-v2 && npx vitest run src/tools/research-competencia-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck y commit**

```bash
cd daemon-v2 && npx tsc --noEmit
git add daemon-v2/src/tools/research-competencia-agent.ts daemon-v2/src/tools/research-competencia-agent.test.ts
git commit -m "feat(research-competencia): el prompt reconoce RRSS como fuente citable"
```

---

### Task 12: Cookies en los 3 puntos de entrada

**Files:**
- Modify: `daemon-v2/src/index.ts` (cron y tool ya existentes)
- Modify: `daemon-v2/src/proactive/research-competencia-weekly.ts`
- Modify: `daemon-v2/scripts/research-competencia-now.ts`
- Modify: `daemon-v2/package.json`
- Test: `daemon-v2/src/proactive/research-competencia-weekly.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```typescript
it("le pasa el proveedor de cookies al research", async () => {
  const getCookies = vi.fn(async () => []);
  await checkResearchCompetenciaWeekly({ botToken: "t", chatId: 1, getCookies });
  expect(vi.mocked(runResearchCompetencia).mock.calls[0][0]).toMatchObject({ timeframeDias: 7, getCookies });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd daemon-v2 && npx vitest run src/proactive/research-competencia-weekly.test.ts`
Expected: FAIL — `getCookies` no llega a `runResearchCompetencia`

- [ ] **Step 3: Implementar**

En `research-competencia-weekly.ts`:

```typescript
import type { StructuredCookie } from "../tools/cookie-jar.js";

export interface ResearchCompetenciaWeeklyOpts {
  botToken: string;
  chatId: number;
  getCookies?: (hostname: string) => Promise<StructuredCookie[]>;
}

// dentro de la función, reemplazar la llamada actual:
result = await runResearchCompetencia({ timeframeDias: 7, getCookies: opts.getCookies });
```

En `index.ts`, donde se agenda el cron (`scheduleResearchCompetenciaWeekly`), pasar el proveedor construido sobre el KV del Cookie Broker que ya existe en ese archivo (`cookieJarKv`):

```typescript
const getSocialCookies = async (hostname: string) => (await getStructuredCookies(hostname, cookieJarKv)).cookies;
```

Ese mismo `getSocialCookies` se pasa tanto al cron como a la tool `investigarCompetencia` de `agent-tools.ts` (que ya recibe deps del daemon).

En `scripts/research-competencia-now.ts`, construir el KV desde el entorno (que ahora llega vía `op run`):

```typescript
import { CfKv } from "../src/cf-kv.js";
import { COOKIE_JAR_NAMESPACE_ID, getStructuredCookies } from "../src/tools/cookie-jar.js";

const cookieJarKv = new CfKv({
  accountId: process.env.CF_ACCOUNT_ID ?? "",
  namespaceId: COOKIE_JAR_NAMESPACE_ID,
  apiToken: process.env.CF_API_TOKEN ?? "",
});
const getCookies = async (hostname: string) => (await getStructuredCookies(hostname, cookieJarKv)).cookies;

const result = await runResearchCompetencia({ timeframeDias, entidadIds, getCookies });
```

En `package.json`, el script pasa a correr bajo 1Password para tener `CF_*`, `OPENROUTER_API_KEY` y `ELEVENLABS_API_KEY` (las 4 ya están en `~/.cos-agent/apps-env.1password.tpl`):

```json
"research:now": "op run --env-file=$HOME/.cos-agent/apps-env.1password.tpl -- tsx scripts/research-competencia-now.ts"
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `cd daemon-v2 && npx vitest run src/proactive/research-competencia-weekly.test.ts`
Expected: PASS

- [ ] **Step 5: Suite completa, typecheck, build y commit**

```bash
cd daemon-v2 && npx vitest run && npx tsc --noEmit && npm run build
git add daemon-v2/src/index.ts daemon-v2/src/proactive/research-competencia-weekly.ts daemon-v2/src/proactive/research-competencia-weekly.test.ts daemon-v2/scripts/research-competencia-now.ts daemon-v2/package.json
git commit -m "feat(research-competencia): cookies del broker en los 3 puntos de entrada"
```

---

### Task 13: Whitelist de dominios y verificación en vivo de los scrapers

**Files:**
- Modify: `~/.claude/config/cookie-jar-domains.json` (fuera del repo)
- Modify: `daemon-v2/src/tools/research-competencia-social.ts` (ajuste de selectores según lo que se vea en vivo)

**Contexto:** Los 4 parsers están testeados contra fixtures, pero los selectores y rutas de JSON reales solo se pueden validar contra las páginas en vivo. Esta task es de verificación y ajuste, no de diseño nuevo.

- [ ] **Step 1: Agregar los 4 dominios a la whitelist del Cookie Broker**

```bash
node -e '
const fs=require("fs");const p=process.env.HOME+"/.claude/config/cookie-jar-domains.json";
const c=JSON.parse(fs.readFileSync(p,"utf8"));
for(const d of ["instagram.com","tiktok.com","facebook.com","x.com"]){
  if(!c.domains.some(x=>x.domain===d)) c.domains.push({domain:d});
}
fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");
console.log(c.domains.map(d=>d.domain).join(", "));
'
```

Expected: la salida lista los dominios previos más los 4 nuevos.

- [ ] **Step 2: Sincronizar las cookies de esos dominios**

```bash
~/.claude/bin/node-fda ~/.claude/scripts/sync-safari-cookies.mjs
```

Expected: una línea `<dominio>: cookie actualizada` por cada dominio donde haya sesión activa en Safari. Si alguno dice que no encontró sesión, hay que iniciar sesión en Safari en ese sitio y volver a correr. **Instagram y Threads/Facebook no comparten cookies aunque compartan cuenta — hay que estar logueado en cada dominio por separado.**

- [ ] **Step 3: Probar cada scraper contra una cuenta real**

```bash
cd daemon-v2 && op run --env-file=$HOME/.cos-agent/apps-env.1password.tpl -- npx tsx -e '
import { scrapeInstagram, scrapeTikTok, scrapeFacebook, scrapeX } from "./src/tools/research-competencia-social.js";
import { CfKv } from "./src/cf-kv.js";
import { COOKIE_JAR_NAMESPACE_ID, getStructuredCookies } from "./src/tools/cookie-jar.js";
const kv = new CfKv({ accountId: process.env.CF_ACCOUNT_ID!, namespaceId: COOKIE_JAR_NAMESPACE_ID, apiToken: process.env.CF_API_TOKEN! });
const ck = async (h: string) => (await getStructuredCookies(h, kv)).cookies;
for (const [nombre, fn, handle, host] of [
  ["instagram", scrapeInstagram, "altoke.bo", "instagram.com"],
  ["tiktok", scrapeTikTok, "altoke.bo", "tiktok.com"],
  ["facebook", scrapeFacebook, "altoke.bo", "facebook.com"],
  ["x", scrapeX, "bancosol", "x.com"],
] as const) {
  const posts = await fn(handle, await ck(host));
  console.log(nombre, "→", posts.length, "posts", posts[0] ? JSON.stringify(posts[0]).slice(0, 200) : "");
}
'
```

Expected: cada plataforma devuelve al menos 1 post con `url`, `caption` y `mediaUrls` poblados.

Si una plataforma devuelve 0 posts, ajustar sus selectores/ruta de JSON en `research-competencia-social.ts` y repetir. Si Facebook o TikTok devuelven 0 de forma sistemática pese a cookies válidas, es el bloqueo anticipado en el spec: dejarlo registrado y seguir — el diseño ya degrada sin romper.

- [ ] **Step 4: Verificar el pipeline multimodal punta a punta con una entidad**

```bash
cd daemon-v2 && npm run research:now -- --timeframe=30 --entidades=bancosol-altoke
```

Expected: la corrida termina sin `⚠️ Falló`, y la página de estado de Banco Sol / Altoke en Notion muestra hallazgos o battlecard con al menos una fuente `instagram.com` o `tiktok.com`.

- [ ] **Step 5: Commit de los ajustes de selectores**

```bash
cd daemon-v2 && npx vitest run && npx tsc --noEmit
git add daemon-v2/src/tools/research-competencia-social.ts
git commit -m "fix(research-competencia): ajustar selectores de scraping según verificación en vivo"
```

---

### Task 14: Despliegue

**Files:** ninguno — es despliegue y verificación.

- [ ] **Step 1: Build final y suite completa**

```bash
cd daemon-v2 && npx vitest run && npx tsc --noEmit && npm run build
```

Expected: todos los tests en verde, sin errores de tipos, build limpio.

- [ ] **Step 2: Reiniciar el daemon — REQUIERE CONFIRMACIÓN EXPLÍCITA DE CAL ANTES DE EJECUTAR**

```bash
launchctl bootout gui/501/com.cal.cos-agent-v2
sleep 2
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
sleep 3
launchctl list | grep cos-agent
```

Expected: PID nuevo con exit status 0, estable tras unos segundos.

- [ ] **Step 3: Prueba real por Telegram — requiere que Cal la haga**

Pedirle a Jano: "corre el research de competencia de los últimos 7 días". Verificar que llega el resumen, que el link del informe abre, y que aparecen hallazgos con fuente de RRSS.

---

## Notas para quien ejecute

- **No inventar handles.** Si un handle de la tabla resulta no existir en vivo, quitarlo de la config y dejar constancia — no sustituirlo por uno parecido.
- **Los 3 niveles de aislamiento de fallas son el corazón del diseño** (post → cuenta → entidad). Cualquier `try/catch` que se saque puede hacer que una plataforma bloqueada tumbe la corrida entera.
- **El daemon no tiene control genérico de browser a propósito** (ver `DISALLOWED_BUILTINS` en `agent-options.ts`). Playwright se usa SOLO dentro de estos módulos, nunca expuesto como tool al LLM — mismo principio que `design-capture.ts`, `boa-checkin` y `cine`.
- **Costo real por corrida:** con los topes del spec, una corrida semanal completa procesa hasta ~24 cuentas × 8 posts, con hasta 4 videos por cuenta a 6 frames cada uno. Estimado 20-40 min. Si en la práctica se dispara, los topes viven como constantes en `research-competencia-social.ts` y `research-competencia-media.ts`.
