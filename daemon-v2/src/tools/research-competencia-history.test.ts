import { describe, it, expect, vi } from "vitest";
import { findExistingUrls, insertPosts, type HistoryPost } from "./research-competencia-history.js";
import { getAggregateStats, formatHistoryText } from "./research-competencia-history.js";

describe("findExistingUrls", () => {
  it("devuelve un Map url->fila para las URLs que ya existen en D1", async () => {
    const queryD1Fn = vi.fn().mockResolvedValue([
      { url: "https://a.com/1", caption: "hola", imagenes_desc: "[]" },
    ]);
    const result = await findExistingUrls(["https://a.com/1", "https://a.com/2"], { queryD1Fn });
    expect(result.size).toBe(1);
    expect(result.get("https://a.com/1")?.caption).toBe("hola");
  });

  it("devuelve un Map vacío (no null) si D1 no responde — fail-soft, todo se trata como nuevo", async () => {
    const queryD1Fn = vi.fn().mockResolvedValue(null);
    const result = await findExistingUrls(["https://a.com/1"], { queryD1Fn });
    expect(result.size).toBe(0);
  });

  it("devuelve un Map vacío sin llamar a D1 si la lista de URLs está vacía", async () => {
    const queryD1Fn = vi.fn();
    const result = await findExistingUrls([], { queryD1Fn });
    expect(result.size).toBe(0);
    expect(queryD1Fn).not.toHaveBeenCalled();
  });

  it("arma el SQL con un placeholder ? por cada URL", async () => {
    const queryD1Fn = vi.fn().mockResolvedValue([]);
    await findExistingUrls(["u1", "u2", "u3"], { queryD1Fn });
    const [sql, params] = queryD1Fn.mock.calls[0];
    expect(sql).toContain("IN (?,?,?)");
    expect(params).toEqual(["u1", "u2", "u3"]);
  });
});

describe("insertPosts", () => {
  const post: HistoryPost = {
    entityId: "takenos",
    platform: "instagram",
    handle: "takenosapp.bo",
    url: "https://instagram.com/p/abc",
    fecha: "2026-09-08",
    caption: "promo",
    esVideo: false,
    mediaUrls: ["https://img.example/1.jpg"],
    imagenes: ["una imagen de una promo"],
    video: undefined,
  };

  it("inserta cada post con INSERT OR IGNORE, sin tirar si D1 falla", async () => {
    const queryD1Fn = vi.fn().mockResolvedValue([]);
    await insertPosts([post], "run-2026-09-08", { queryD1Fn });
    expect(queryD1Fn).toHaveBeenCalledTimes(1);
    const [sql, params] = queryD1Fn.mock.calls[0];
    expect(sql).toContain("INSERT OR IGNORE INTO posts");
    expect(params).toContain("takenos");
    expect(params).toContain("https://instagram.com/p/abc");
  });

  it("no tira si queryD1Fn rechaza — fail-soft", async () => {
    const queryD1Fn = vi.fn().mockRejectedValue(new Error("d1 down"));
    await expect(insertPosts([post], "run-1", { queryD1Fn })).resolves.toBeUndefined();
  });

  it("no llama a D1 si la lista de posts está vacía", async () => {
    const queryD1Fn = vi.fn();
    await insertPosts([], "run-1", { queryD1Fn });
    expect(queryD1Fn).not.toHaveBeenCalled();
  });
});

describe("getAggregateStats", () => {
  it("calcula conteo total y promedio semanal a partir de las filas de D1", async () => {
    const queryD1Fn = vi.fn().mockResolvedValue([{ total: 12, primera_fecha: "2026-06-01", ultima_fecha: "2026-09-01" }]);
    const stats = await getAggregateStats("takenos", 90, { queryD1Fn });
    expect(stats).toEqual({ total: 12, primeraFecha: "2026-06-01", ultimaFecha: "2026-09-01", promedioSemanal: expect.any(Number) });
    expect(stats?.promedioSemanal).toBeCloseTo(0.9, 1);
  });

  it("calcula promedioSemanal correctamente cuando todos los posts están en el mismo día", async () => {
    const queryD1Fn = vi.fn().mockResolvedValue([{ total: 1, primera_fecha: "2026-09-01", ultima_fecha: "2026-09-01" }]);
    const stats = await getAggregateStats("takenos", 90, { queryD1Fn });
    expect(stats?.promedioSemanal).toBe(7); // 1 post en 1 día → extrapolación de 7 posts/semana
  });

  it("devuelve null si D1 no responde — fail-soft", async () => {
    const queryD1Fn = vi.fn().mockResolvedValue(null);
    const stats = await getAggregateStats("takenos", 90, { queryD1Fn });
    expect(stats).toBeNull();
  });

  it("devuelve null si no hay filas (entidad sin historial todavía)", async () => {
    const queryD1Fn = vi.fn().mockResolvedValue([{ total: 0, primera_fecha: null, ultima_fecha: null }]);
    const stats = await getAggregateStats("takenos", 90, { queryD1Fn });
    expect(stats).toBeNull();
  });
});

describe("formatHistoryText", () => {
  it("arma una línea legible por entidad con las stats", () => {
    const texto = formatHistoryText({ total: 12, primeraFecha: "2026-06-01", ultimaFecha: "2026-09-01", promedioSemanal: 0.9 });
    expect(texto).toContain("12 posts");
    expect(texto).toContain("0.9");
  });

  it("devuelve null si stats es null", () => {
    expect(formatHistoryText(null)).toBeNull();
  });
});
