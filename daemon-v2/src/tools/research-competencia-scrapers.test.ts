import { describe, it, expect } from "vitest";
import { parseInstagramPosts, extractInstagramNodes } from "./research-competencia-scrapers.js";

/** Nodo de post válido tal como aparece embebido en el JSON del timeline de Instagram. */
const NODO_VALIDO = {
  shortcode: "XYZ1",
  taken_at_timestamp: 1700000000,
  is_video: false,
  display_url: "https://cdn.instagram.com/x.jpg",
  edge_media_to_caption: { edges: [] },
};

/** Envuelve `valor` en `n` objetos anidados (`{w0:{w1:{...{valor}}}}`) para simular la anidación
 * real de webpack/relay que produce Instagram alrededor del timeline. */
function wrapDeep(valor: unknown, n: number): unknown {
  let out = valor;
  for (let i = n - 1; i >= 0; i--) out = { [`w${i}`]: out };
  return out;
}

/** Texto de script tal como lo ve `extractInstagramNodes` — con el prefijo JS real antes del JSON,
 * ya que la función busca el primer `{` en vez de asumir que el script es JSON puro. Sin sufijo
 * después del JSON: `JSON.parse` es estricto y un `;` colgante rompería el parseo, igual que le
 * pasaría a la implementación real — el prefijo es lo único que `indexOf("{")` está pensado para
 * saltear. */
function scriptTextFor(obj: unknown): string {
  return `window.__additionalData = ${JSON.stringify(obj)}`;
}

describe("parseInstagramPosts", () => {
  it("extrae caption, url, fecha y media de los nodos del perfil", () => {
    const nodos = [
      {
        shortcode: "ABC123",
        taken_at_timestamp: 1788307200, // 2026-09-01 en La Paz (UTC-4); es 2026-09-02T00:00Z
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

describe("extractInstagramNodes", () => {
  it("encuentra un nodo anidado dentro del tope de profundidad", () => {
    // El nodo real vive envuelto en unos pocos objetos wrapper (webpack/relay) — caso típico.
    const scriptTexts = [scriptTextFor(wrapDeep(NODO_VALIDO, 3))];

    const { nodos, diagnostics } = extractInstagramNodes(scriptTexts);

    expect(nodos).toEqual([NODO_VALIDO]);
    expect(diagnostics).toEqual({ scriptsConPatron: 1, scriptsConNodosValidos: 1 });
  });

  it("NO encuentra un nodo a más de 8 niveles de profundidad — documenta el tope de MAX_WALK_DEPTH", () => {
    // Con el nodo envuelto en 9 objetos, el recorrido lo visita en profundidad 9 (>8) y corta
    // antes de revisar si tiene `shortcode` — se pierde en silencio salvo por el diagnóstico:
    // scriptsConPatron queda en 1 (el script SÍ tenía el literal "shortcode", solo que dentro del
    // string JSON, no como propiedad alcanzada) pero scriptsConNodosValidos queda en 0. Si algún
    // día la estructura real de Instagram anida más profundo que esto, el síntoma en producción es
    // exactamente esta combinación — ver el comentario de MAX_WALK_DEPTH en la implementación.
    const scriptTexts = [scriptTextFor(wrapDeep(NODO_VALIDO, 9))];

    const { nodos, diagnostics } = extractInstagramNodes(scriptTexts);

    expect(nodos).toEqual([]);
    expect(diagnostics).toEqual({ scriptsConPatron: 1, scriptsConNodosValidos: 0 });
  });

  it("encuentra el nodo justo en el límite (8 niveles de profundidad)", () => {
    const scriptTexts = [scriptTextFor(wrapDeep(NODO_VALIDO, 8))];

    const { nodos } = extractInstagramNodes(scriptTexts);

    expect(nodos).toEqual([NODO_VALIDO]);
  });

  it("ignora un script sin JSON válido en vez de romper, y no lo cuenta como productivo", () => {
    const scriptTexts = ["window.foo = {not valid json here shortcode"];

    const { nodos, diagnostics } = extractInstagramNodes(scriptTexts);

    expect(nodos).toEqual([]);
    expect(diagnostics).toEqual({ scriptsConPatron: 1, scriptsConNodosValidos: 0 });
  });
});
