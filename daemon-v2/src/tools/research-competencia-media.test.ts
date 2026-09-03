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
