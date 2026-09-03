import { describe, it, expect, vi, afterEach } from "vitest";
import { makeResearchCompetenciaCookiesProvider, SOCIAL_DOMAINS } from "./research-competencia-cookies.js";

/** Cookie cruda tal como la devuelve parseSafariCookies (safari-fetch.mjs) — domain SIN punto
 * inicial (esa función ya lo saca vía `.replace(/^\./, "")`). */
function rawCookie(overrides: Partial<{ domain: string; name: string; path: string; value: string; expiry: number }> = {}) {
  return { domain: "instagram.com", name: "sessionid", path: "/", value: "abc123", expiry: 0, ...overrides };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("makeResearchCompetenciaCookiesProvider", () => {
  it("hostname fuera de la lista de dominios sociales devuelve [] sin leer nada", async () => {
    const readCookiesFile = vi.fn();
    const parseCookies = vi.fn();
    const provider = makeResearchCompetenciaCookiesProvider({ readCookiesFile, parseCookies });

    const result = await provider("banco.com");

    expect(result).toEqual([]);
    expect(readCookiesFile).not.toHaveBeenCalled();
    expect(parseCookies).not.toHaveBeenCalled();
  });

  it("hostname en la lista con cookies vigentes devuelve StructuredCookie bien formado", async () => {
    const readCookiesFile = vi.fn(() => Buffer.from(""));
    const parseCookies = vi.fn(() => [rawCookie({ name: "sessionid", value: "abc123", path: "/", expiry: 0 })]);
    const provider = makeResearchCompetenciaCookiesProvider({ readCookiesFile, parseCookies });

    const result = await provider("instagram.com");

    expect(result).toEqual([{ name: "sessionid", value: "abc123", domain: ".instagram.com", path: "/" }]);
  });

  it("descarta cookies expiradas", async () => {
    const reloj = () => new Date("2026-09-01T00:00:00Z").getTime();
    const expiroAyer = Math.floor(new Date("2026-08-31T00:00:00Z").getTime() / 1000);
    const parseCookies = vi.fn(() => [
      rawCookie({ name: "vieja", expiry: expiroAyer }),
      rawCookie({ name: "vigente", expiry: 0 }),
    ]);
    const provider = makeResearchCompetenciaCookiesProvider({
      readCookiesFile: () => Buffer.from(""),
      parseCookies,
      reloj,
    });

    const result = await provider("instagram.com");

    expect(result.map((c) => c.name)).toEqual(["vigente"]);
  });

  it("un subdominio (www.instagram.com) matchea el dominio configurado (instagram.com)", async () => {
    const parseCookies = vi.fn(() => [rawCookie({ domain: "instagram.com", name: "sessionid" })]);
    const provider = makeResearchCompetenciaCookiesProvider({
      readCookiesFile: () => Buffer.from(""),
      parseCookies,
    });

    const result = await provider("www.instagram.com");

    expect(result).toHaveLength(1);
    // El domain de salida usa el dominio CONFIGURADO con punto inicial (gotcha de Playwright:
    // el shorthand `url` hace la cookie host-only) — no el hostname pedido.
    expect(result[0].domain).toBe(".instagram.com");
  });

  it("falla de lectura del archivo de Safari devuelve [] y loguea el hint de Full Disk Access", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const readCookiesFile = vi.fn(() => {
      throw new Error("EACCES: permission denied");
    });
    const provider = makeResearchCompetenciaCookiesProvider({ readCookiesFile, parseCookies: vi.fn() });

    const result = await provider("tiktok.com");

    expect(result).toEqual([]);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(logged.hostname).toBe("tiktok.com");
    expect(logged.err).toContain("EACCES");
    expect(logged.hint).toMatch(/Full Disk Access/i);
    expect(logged.hint).toMatch(/node-fda/);
  });

  it("archivo vacío / sin cookies para ese dominio devuelve []", async () => {
    const parseCookies = vi.fn(() => [rawCookie({ domain: "tiktok.com" })]);
    const provider = makeResearchCompetenciaCookiesProvider({
      readCookiesFile: () => Buffer.from(""),
      parseCookies,
    });

    // instagram.com está en la lista, pero el archivo solo tiene cookies de tiktok.com
    const result = await provider("instagram.com");

    expect(result).toEqual([]);
  });

  it("SOCIAL_DOMAINS incluye las 4 redes del research más twitter.com", () => {
    expect(SOCIAL_DOMAINS).toEqual(
      expect.arrayContaining(["instagram.com", "tiktok.com", "facebook.com", "x.com", "twitter.com"]),
    );
  });
});
