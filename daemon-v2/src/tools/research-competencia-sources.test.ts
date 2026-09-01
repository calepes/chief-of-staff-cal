import { describe, it, expect, vi } from "vitest";
import { extractVisibleText, chunkText, fetchIosAppInfo, fetchAndroidAppInfo, fetchSiteText } from "./research-competencia-sources.js";

describe("extractVisibleText", () => {
  it("saca scripts, estilos y tags, colapsa espacios", () => {
    const html = `<html><head><style>.a{color:red}</style><script>alert(1)</script></head><body><h1>Título</h1><p>Texto  con   espacios</p></body></html>`;
    expect(extractVisibleText(html)).toBe("Título Texto con espacios");
  });

  it("decodifica entidades HTML básicas", () => {
    expect(extractVisibleText("<p>A &amp; B &lt;3&gt;</p>")).toBe("A & B <3>");
  });
});

describe("chunkText", () => {
  it("no divide texto corto", () => {
    expect(chunkText("hola mundo", 100)).toEqual(["hola mundo"]);
  });

  it("divide por espacios sin cortar palabras", () => {
    const text = "una dos tres cuatro cinco";
    const chunks = chunkText(text, 10);
    expect(chunks.every((c) => c.length <= 10)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text);
  });
});

describe("fetchIosAppInfo", () => {
  it("resuelve por trackId directo", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [{ version: "3.2", averageUserRating: 4.5, userRatingCount: 120, releaseNotes: "Fixes" }] }),
    })) as unknown as typeof fetch;
    const info = await fetchIosAppInfo({ trackId: "123" }, fetchFn);
    expect(info).toEqual({ version: "3.2", rating: 4.5, ratingCount: 120, releaseNotes: "Fixes" });
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining("lookup?id=123"), expect.anything());
  });

  it("devuelve null si la respuesta no trae resultados", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ results: [] }) })) as unknown as typeof fetch;
    expect(await fetchIosAppInfo({ trackId: "123" }, fetchFn)).toBeNull();
  });

  it("devuelve null si el fetch no es ok", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;
    expect(await fetchIosAppInfo({ trackId: "123" }, fetchFn)).toBeNull();
  });
});

describe("fetchAndroidAppInfo", () => {
  it("mapea los campos de google-play-scraper", async () => {
    const gplayFn = vi.fn(async () => ({ version: "1.0.5", score: 4.1, ratings: 900, recentChanges: "Novedades" }));
    const info = await fetchAndroidAppInfo("com.example.app", gplayFn as any);
    expect(info).toEqual({ version: "1.0.5", rating: 4.1, ratingCount: 900, releaseNotes: "Novedades" });
  });

  it("devuelve null si el scraper tira error (app no encontrada, etc.)", async () => {
    const gplayFn = vi.fn(async () => { throw new Error("Not Found"); });
    expect(await fetchAndroidAppInfo("com.no.existe", gplayFn as any)).toBeNull();
  });
});

describe("fetchSiteText", () => {
  it("extrae texto visible y lo trunca a 5000 chars", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, text: async () => `<p>${"a".repeat(6000)}</p>` })) as unknown as typeof fetch;
    const text = await fetchSiteText("https://example.com", fetchFn);
    expect(text).toHaveLength(5000);
  });

  it("devuelve null si el fetch falla", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("timeout"); }) as unknown as typeof fetch;
    expect(await fetchSiteText("https://example.com", fetchFn)).toBeNull();
  });
});
