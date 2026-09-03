import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Directorios `rc-img-*` que describeImage crea con mkdtemp — deberían desaparecer al terminar. */
function rcImgDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("rc-img-"));
}

vi.mock("./vision.js", () => ({
  analyzePhoto: vi.fn(async () => ({ text: "Un flyer con la promo 2x1", rawTokens: { input: 1, output: 1 } })),
}));

vi.mock("./whisper.js", () => ({
  transcribeAudio: vi.fn(async () => "Hola, te presentamos el nuevo crédito digital"),
}));

import {
  downloadMedia,
  describeImage,
  analyzeVideo,
  videoDurationSec,
  buildFrameExtractArgs,
  MAX_VIDEO_DURATION_SEC,
  FFMPEG,
} from "./research-competencia-media.js";
import { analyzePhoto } from "./vision.js";
import { transcribeAudio } from "./whisper.js";

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

  it("devuelve null si analyzePhoto tira (ej. falta OPENROUTER_API_KEY), sin propagar el error", async () => {
    vi.mocked(analyzePhoto).mockRejectedValueOnce(new Error("OPENROUTER_API_KEY no configurada"));
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;
    expect(await describeImage("https://cdn/x.jpg", fetchFn)).toBeNull();
  });

  it("borra el directorio temporal tras terminar, con descarga exitosa", async () => {
    const before = rcImgDirs();
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;
    await describeImage("https://cdn/x.jpg", fetchFn);
    expect(rcImgDirs().filter((d) => !before.includes(d))).toEqual([]);
  });

  it("borra el directorio temporal tras terminar, con descarga fallida", async () => {
    const before = rcImgDirs();
    const fetchFn = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await describeImage("https://cdn/x.jpg", fetchFn);
    expect(rcImgDirs().filter((d) => !before.includes(d))).toEqual([]);
  });
});

describe("videoDurationSec", () => {
  // Video real de 2s generado con el ffmpeg del propio sistema (mismo binario que usa el módulo)
  // — evita mockear child_process para probar el parseo real del stdout de ffprobe.
  const dir = mkdtempSync(join(tmpdir(), "rc-media-vdtest-"));
  const videoPath = join(dir, "sample.mp4");

  beforeAll(() => {
    execFileSync(FFMPEG, ["-y", "-f", "lavfi", "-i", "color=c=black:s=32x32:d=2", "-loglevel", "error", videoPath]);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parsea el stdout de ffprobe a un número", async () => {
    const dur = await videoDurationSec(videoPath);
    expect(dur).not.toBeNull();
    expect(dur as number).toBeGreaterThan(1.5);
    expect(dur as number).toBeLessThan(2.5);
  });

  it("devuelve null si ffprobe falla (archivo inexistente)", async () => {
    expect(await videoDurationSec(join(dir, "no-existe.mp4"))).toBeNull();
  });
});

describe("buildFrameExtractArgs", () => {
  it("centra el bucket: primer frame a interval/2, no en t=0", () => {
    const args = buildFrameExtractArgs("/tmp/v.mp4", "/tmp/out", 6, 60);
    // interval = 60/6 = 10, offset = interval/2 = 5, fps = 1/interval = 0.1
    expect(args).toContain("-ss");
    expect(args[args.indexOf("-ss") + 1]).toBe("5.000");
    expect(args.find((a) => a.startsWith("fps="))).toBe("fps=0.1000");
  });

  it("sin duración conocida, cae al fallback de 1 frame cada 2s sin offset", () => {
    const args = buildFrameExtractArgs("/tmp/v.mp4", "/tmp/out", 6, null);
    expect(args).not.toContain("-ss");
    expect(args.find((a) => a.startsWith("fps="))).toBe("fps=0.5000");
  });
});

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

  it("video sin pista de audio: saltea la transcripción sin loguear error, y sigue con los frames", async () => {
    vi.mocked(transcribeAudio).mockClear();
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof fetch;
    const durationFn = vi.fn(async () => 20);
    const hasAudioFn = vi.fn(async () => false);
    const runFfmpegFn = vi.fn(async (_args: string[], dir: string) => {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await writeFile(join(dir, "frame_01.jpg"), Buffer.from([1]));
    });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await analyzeVideo("https://cdn/v.mp4", { fetchFn, durationFn, hasAudioFn, runFfmpegFn });

    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(result?.transcripcion).toBe("");
    expect(result?.frames).toEqual(["Un flyer con la promo 2x1"]);
    // Ningún log con "_error": un video mudo no es una falla real (issue de calidad #3).
    expect(consoleSpy.mock.calls.some(([line]) => String(line).includes("_error"))).toBe(false);
    consoleSpy.mockRestore();
  });

  it("resultado parcial: la transcripción falla pero los frames salen bien", async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof fetch;
    const durationFn = vi.fn(async () => 20);
    const hasAudioFn = vi.fn(async () => true);
    const runFfmpegFn = vi.fn(async (_args: string[], dir: string) => {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await writeFile(join(dir, "frame_01.jpg"), Buffer.from([1]));
    });
    vi.mocked(transcribeAudio).mockRejectedValueOnce(new Error("whisper caído"));

    const result = await analyzeVideo("https://cdn/v.mp4", { fetchFn, durationFn, hasAudioFn, runFfmpegFn });

    expect(result?.transcripcion).toBe("");
    expect(result?.frames).toEqual(["Un flyer con la promo 2x1"]);
  });

  it("resultado parcial (inverso): los frames fallan pero la transcripción sale bien", async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof fetch;
    const durationFn = vi.fn(async () => 20);
    const hasAudioFn = vi.fn(async () => true);
    // La extracción de audio (sin "-vf") "funciona"; la de frames (con "-vf") tira.
    const runFfmpegFn = vi.fn(async (args: string[]) => {
      if (args.includes("-vf")) throw new Error("ffmpeg roto extrayendo frames");
    });

    const result = await analyzeVideo("https://cdn/v.mp4", { fetchFn, durationFn, hasAudioFn, runFfmpegFn });

    expect(result?.transcripcion).toContain("crédito digital");
    expect(result?.frames).toEqual([]);
  });

  it("un frame que falla no aborta los demás", async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof fetch;
    const durationFn = vi.fn(async () => 20);
    const hasAudioFn = vi.fn(async () => false);
    const runFfmpegFn = vi.fn(async (_args: string[], dir: string) => {
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await writeFile(join(dir, "frame_01.jpg"), Buffer.from([1]));
      await writeFile(join(dir, "frame_02.jpg"), Buffer.from([1]));
    });
    vi.mocked(analyzePhoto).mockRejectedValueOnce(new Error("modelo de visión caído"));

    const result = await analyzeVideo("https://cdn/v.mp4", { fetchFn, durationFn, hasAudioFn, runFfmpegFn });

    // El primer frame (frame_01) falló y se descartó; el segundo (frame_02) sí entró.
    expect(result?.frames).toEqual(["Un flyer con la promo 2x1"]);
  });
});
