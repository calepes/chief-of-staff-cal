import { describe, it, expect } from "vitest";
import {
  parseInstagramPosts,
  extractInstagramNodes,
  parseTikTokPosts,
  extractTikTokNodes,
} from "./research-competencia-scrapers.js";

/** Handle de la cuenta scrapeada en los tests de extracción — el mismo en Instagram y TikTok. */
const HANDLE = "altoke.bo";

/** Nodo de post válido tal como aparece embebido en el JSON del timeline de Instagram. Incluye
 * `owner.username` porque el matcher exige validar autoría (ver comentario de `ownerUsernameMatches`
 * en la implementación) — sin este campo, `extractInstagramNodes` descarta el nodo aunque matchee
 * la forma. */
const NODO_VALIDO = {
  shortcode: "XYZ1",
  taken_at_timestamp: 1700000000,
  is_video: false,
  display_url: "https://cdn.instagram.com/x.jpg",
  edge_media_to_caption: { edges: [] },
  owner: { username: HANDLE },
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

    const { nodos, diagnostics } = extractInstagramNodes(scriptTexts, HANDLE);

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

    const { nodos, diagnostics } = extractInstagramNodes(scriptTexts, HANDLE);

    expect(nodos).toEqual([]);
    expect(diagnostics).toEqual({ scriptsConPatron: 1, scriptsConNodosValidos: 0 });
  });

  it("encuentra el nodo justo en el límite (8 niveles de profundidad)", () => {
    const scriptTexts = [scriptTextFor(wrapDeep(NODO_VALIDO, 8))];

    const { nodos } = extractInstagramNodes(scriptTexts, HANDLE);

    expect(nodos).toEqual([NODO_VALIDO]);
  });

  it("ignora un script sin JSON válido en vez de romper, y no lo cuenta como productivo", () => {
    const scriptTexts = ["window.foo = {not valid json here shortcode"];

    const { nodos, diagnostics } = extractInstagramNodes(scriptTexts, HANDLE);

    expect(nodos).toEqual([]);
    expect(diagnostics).toEqual({ scriptsConPatron: 1, scriptsConNodosValidos: 0 });
  });

  it("GRAVE: descarta un post recomendado de otra cuenta mezclado en el mismo payload", () => {
    // El payload del perfil trae también contenido sugerido/relacionado con la misma forma
    // (shortcode+is_video) pero de otro `owner.username` — sin validar autoría, este nodo se
    // atribuiría igual al handle scrapeado. Ver el comentario de `ownerUsernameMatches`.
    const nodoAjeno = {
      shortcode: "AJENO1",
      taken_at_timestamp: 1700000000,
      is_video: false,
      display_url: "https://cdn.instagram.com/ajeno.jpg",
      owner: { username: "otra-cuenta" },
    };
    const scriptTexts = [scriptTextFor({ propio: NODO_VALIDO, sugerido: nodoAjeno })];

    const { nodos } = extractInstagramNodes(scriptTexts, HANDLE);

    expect(nodos).toEqual([NODO_VALIDO]);
  });

  it("descarta un nodo con la forma correcta pero sin owner.username (autor no verificable)", () => {
    const sinOwner = { shortcode: "SINOWNER", is_video: false };
    const scriptTexts = [scriptTextFor(sinOwner)];

    const { nodos } = extractInstagramNodes(scriptTexts, HANDLE);

    expect(nodos).toEqual([]);
  });
});

describe("parseTikTokPosts", () => {
  it("extrae descripción, url, fecha y video", () => {
    const items = [
      {
        id: "7500000000000000000",
        desc: "Así funciona el QR delegado",
        createTime: 1788307200,
        video: { playAddr: "https://cdn.tiktok.com/v.mp4" },
      },
    ];

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

  it("usa string vacío de caption si falta desc, y mediaUrls vacío si falta el video", () => {
    const posts = parseTikTokPosts([{ id: "1" }], "altoke.bo");
    expect(posts[0]).toMatchObject({ caption: "", mediaUrls: [], esVideo: true });
  });
});

/** Item de video válido tal como aparece embebido en el JSON de rehidratación de TikTok. Incluye
 * `author.uniqueId` porque el matcher exige validar autoría (ver comentario de
 * `authorUniqueIdMatches` en la implementación) — sin este campo, `extractTikTokNodes` descarta
 * el item aunque matchee la forma. */
const ITEM_VALIDO = {
  id: "7500000000000000001",
  desc: "Otro video",
  createTime: 1700000000,
  video: { playAddr: "https://cdn.tiktok.com/otro.mp4" },
  author: { uniqueId: HANDLE },
};

/** Mismo propósito que `scriptTextFor` de arriba, adaptado al script de rehidratación de TikTok
 * (`__UNIVERSAL_DATA_FOR_REHYDRATION__` es JSON puro sin prefijo `window.x =`, pero igual se
 * respeta el patrón de `indexOf("{")` + sin sufijo colgante tras el JSON). */
function tiktokScriptTextFor(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("extractTikTokNodes", () => {
  it("encuentra un item anidado dentro del tope de profundidad", () => {
    const scriptTexts = [tiktokScriptTextFor(wrapDeep(ITEM_VALIDO, 3))];

    const { nodos, diagnostics } = extractTikTokNodes(scriptTexts, HANDLE);

    expect(nodos).toEqual([ITEM_VALIDO]);
    expect(diagnostics).toEqual({ scriptsConPatron: 1, scriptsConNodosValidos: 1 });
  });

  it("NO encuentra un item a más de 8 niveles de profundidad — mismo tope que Instagram", () => {
    const scriptTexts = [tiktokScriptTextFor(wrapDeep(ITEM_VALIDO, 9))];

    const { nodos, diagnostics } = extractTikTokNodes(scriptTexts, HANDLE);

    expect(nodos).toEqual([]);
    expect(diagnostics).toEqual({ scriptsConPatron: 1, scriptsConNodosValidos: 0 });
  });

  it("encuentra el item justo en el límite (8 niveles de profundidad)", () => {
    const scriptTexts = [tiktokScriptTextFor(wrapDeep(ITEM_VALIDO, 8))];

    const { nodos } = extractTikTokNodes(scriptTexts, HANDLE);

    expect(nodos).toEqual([ITEM_VALIDO]);
  });

  it("ignora un script sin JSON válido en vez de romper, y no lo cuenta como productivo", () => {
    const scriptTexts = ["{not valid json here desc video"];

    const { nodos, diagnostics } = extractTikTokNodes(scriptTexts, HANDLE);

    expect(nodos).toEqual([]);
    expect(diagnostics).toEqual({ scriptsConPatron: 1, scriptsConNodosValidos: 0 });
  });

  it("GRAVE: descarta un video recomendado de otra cuenta mezclado en el mismo payload", () => {
    // El payload de rehidratación del perfil trae también videos recomendados con la misma forma
    // (id+desc+video) pero de otro `author.uniqueId` — sin validar autoría, este item se
    // atribuiría igual al handle scrapeado, con una URL bien formada pero falsa. Ver el
    // comentario de `authorUniqueIdMatches`.
    const itemAjeno = {
      id: "9999999999999999999",
      desc: "Video de otra cuenta",
      createTime: 1700000000,
      video: { playAddr: "https://cdn.tiktok.com/ajeno.mp4" },
      author: { uniqueId: "otra-cuenta" },
    };
    const scriptTexts = [tiktokScriptTextFor({ propio: ITEM_VALIDO, recomendado: itemAjeno })];

    const { nodos } = extractTikTokNodes(scriptTexts, HANDLE);

    expect(nodos).toEqual([ITEM_VALIDO]);
  });

  it("descarta un item con la forma correcta pero sin author.uniqueId (autor no verificable)", () => {
    const sinAutor = { id: "1", desc: "x", video: { playAddr: "https://cdn.tiktok.com/x.mp4" } };
    const scriptTexts = [tiktokScriptTextFor(sinAutor)];

    const { nodos } = extractTikTokNodes(scriptTexts, HANDLE);

    expect(nodos).toEqual([]);
  });

  it("casi matchea: id numérico en vez de string no cuenta (regresión de tipo)", () => {
    const idNumerico = { id: 12345, desc: "x", video: { playAddr: "https://cdn.tiktok.com/x.mp4" }, author: { uniqueId: HANDLE } };
    const scriptTexts = [tiktokScriptTextFor(idNumerico)];

    const { nodos } = extractTikTokNodes(scriptTexts, HANDLE);

    expect(nodos).toEqual([]);
  });

  it("casi matchea: desc+video sin id no cuenta", () => {
    const sinId = { desc: "x", video: { playAddr: "https://cdn.tiktok.com/x.mp4" }, author: { uniqueId: HANDLE } };
    const scriptTexts = [tiktokScriptTextFor(sinId)];

    const { nodos } = extractTikTokNodes(scriptTexts, HANDLE);

    expect(nodos).toEqual([]);
  });

  it("casi matchea: id+video sin desc no cuenta", () => {
    const sinDesc = { id: "1", video: { playAddr: "https://cdn.tiktok.com/x.mp4" }, author: { uniqueId: HANDLE } };
    const scriptTexts = [tiktokScriptTextFor(sinDesc)];

    const { nodos } = extractTikTokNodes(scriptTexts, HANDLE);

    expect(nodos).toEqual([]);
  });
});
