import { describe, it, expect, vi } from "vitest";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";

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

import { downloadMedia, describeImage, analyzeVideo, videoDurationSec, MAX_VIDEO_DURATION_SEC } from "./research-competencia-media.js";
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
