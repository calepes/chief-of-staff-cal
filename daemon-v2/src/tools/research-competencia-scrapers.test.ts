import { describe, it, expect } from "vitest";
import {
  parseInstagramGridItems,
  parseInstagramPhotoAltDate,
  type RawInstagramGridItem,
  parseTikTokPosts,
  extractTikTokNodes,
  parseDomPosts,
  deriveAuthorFromPermalink,
  type RawDomPost,
} from "./research-competencia-scrapers.js";

/** Handle de la cuenta scrapeada en los tests de extracción — el mismo en Instagram y TikTok. */
const HANDLE = "altoke.bo";

/** Envuelve `valor` en `n` objetos anidados (`{w0:{w1:{...{valor}}}}`) para simular la anidación
 * real de webpack/relay que produce TikTok alrededor del timeline. */
function wrapDeep(valor: unknown, n: number): unknown {
  let out = valor;
  for (let i = n - 1; i >= 0; i--) out = { [`w${i}`]: out };
  return out;
}

describe("parseInstagramPhotoAltDate", () => {
  it("parsea el patrón real 'Photo by {autor} on {Month DD, YYYY}. ...'", () => {
    expect(parseInstagramPhotoAltDate("Photo by altoke on August 20, 2026. May be a meme of...")).toBe("2026-08-20");
  });

  it("acepta día de un solo dígito sin cero a la izquierda en el texto original", () => {
    expect(parseInstagramPhotoAltDate("Photo by altoke on September 1, 2026. May be...")).toBe("2026-09-01");
  });

  it("null si el alt no sigue el patrón (ej. es el caption real de un reel)", () => {
    expect(parseInstagramPhotoAltDate("💰👀 ¿Duplicar tus ahorros? #altoke")).toBeNull();
  });

  it("null con string vacío", () => {
    expect(parseInstagramPhotoAltDate("")).toBeNull();
  });

  it("null si el mes no es un mes en inglés válido", () => {
    expect(parseInstagramPhotoAltDate("Photo by altoke on Septiembre 1, 2026. May be...")).toBeNull();
  });
});

describe("parseInstagramGridItems", () => {
  function item(overrides: Partial<RawInstagramGridItem> = {}): RawInstagramGridItem {
    return {
      href: "/altoke.bo/p/ABC123/",
      imgSrc: "https://cdn.instagram.com/foto.jpg",
      imgAlt: "Photo by altoke on August 20, 2026. May be a meme of...",
      ...overrides,
    };
  }

  it("una FOTO: fecha parseada del alt, caption vacío (el alt es visión auto-generada, no un caption real)", () => {
    const posts = parseInstagramGridItems([item()], HANDLE);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      platform: "instagram", handle: HANDLE,
      url: "https://www.instagram.com/altoke.bo/p/ABC123/",
      fecha: "2026-08-20", caption: "", esVideo: false,
      mediaUrls: ["https://cdn.instagram.com/foto.jpg"],
    });
  });

  it("un REEL: el alt ES el caption real completo, pero sin fecha (el patrón de fecha solo existe en fotos)", () => {
    const caption = "💰👀 ¿Duplicar tus ahorros? Ahorra desde Bs 200. #altoke #bolivia";
    const posts = parseInstagramGridItems(
      [item({ href: "/altoke.bo/reel/Dc30ov5AcJ4/", imgAlt: caption })],
      HANDLE,
    );
    expect(posts[0]).toMatchObject({ caption, fecha: null, esVideo: false });
  });

  it("esVideo SIEMPRE false, incluso para un reel — mediaUrls es la miniatura, no hay URL de video real", () => {
    const posts = parseInstagramGridItems([item({ href: "/altoke.bo/reel/X/", imgAlt: "caption real" })], HANDLE);
    expect(posts[0].esVideo).toBe(false);
    expect(posts[0].mediaUrls).toEqual(["https://cdn.instagram.com/foto.jpg"]);
  });

  it("caption vacío si el alt de una foto es null", () => {
    const posts = parseInstagramGridItems([item({ imgAlt: null })], HANDLE);
    expect(posts[0].caption).toBe("");
    expect(posts[0].fecha).toBeNull();
  });

  it("descarta un ítem cuyo primer segmento de href no matchea el handle (fail-closed)", () => {
    const posts = parseInstagramGridItems([item({ href: "/otra-cuenta/p/X/" })], HANDLE);
    expect(posts).toEqual([]);
  });

  it("preserva el orden del grid tal cual — NO reordena por fecha (a diferencia de los demás parsers)", () => {
    // Reel primero (sin fecha), foto después (con fecha) — si se aplicara sortPostsByFechaDesc el
    // reel iría al final. Acá tiene que quedar en el mismo orden de entrada.
    const posts = parseInstagramGridItems(
      [
        item({ href: "/altoke.bo/reel/R1/", imgAlt: "caption reel" }),
        item({ href: "/altoke.bo/p/P1/", imgAlt: "Photo by altoke on August 01, 2026. ..." }),
      ],
      HANDLE,
    );
    expect(posts.map((p) => p.url)).toEqual([
      "https://www.instagram.com/altoke.bo/reel/R1/",
      "https://www.instagram.com/altoke.bo/p/P1/",
    ]);
  });

  it("lista vacía sin ítems", () => {
    expect(parseInstagramGridItems([], HANDLE)).toEqual([]);
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

  it("ordena más-reciente-primero aunque los items crudos vengan desordenados (IMPORTANTE 4)", () => {
    const posts = parseTikTokPosts(
      [
        { id: "viejo", createTime: 1700000000 },
        { id: "nuevo", createTime: 1700259200 }, // +3 días
      ],
      "altoke.bo",
    );
    expect(posts.map((p) => p.url)).toEqual([
      "https://www.tiktok.com/@altoke.bo/video/nuevo",
      "https://www.tiktok.com/@altoke.bo/video/viejo",
    ]);
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

describe("parseDomPosts", () => {
  it("normaliza posts crudos del DOM a SocialPost", () => {
    const crudos: RawDomPost[] = [{
      url: "https://x.com/bancosol/status/123",
      texto: "Nueva campaña de ahorro",
      fechaIso: "2026-09-01T10:00:00.000Z",
      imagenes: ["https://pbs.twimg.com/media/a.jpg"],
      videos: [],
      autor: "bancosol",
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
      autor: "altoke.bo",
    }];

    const posts = parseDomPosts(crudos, "facebook", "altoke.bo");

    expect(posts[0].esVideo).toBe(true);
    expect(posts[0].mediaUrls).toEqual(["https://cdn/video.mp4"]);
    expect(posts[0].fecha).toBeNull();
  });

  it("descarta posts sin url", () => {
    const crudos = [{ url: "", texto: "x", fechaIso: null, imagenes: [], videos: [], autor: "x" }] as RawDomPost[];
    expect(parseDomPosts(crudos, "facebook", "x")).toEqual([]);
  });

  it("descarta un post cuyo autor no es la cuenta scrapeada (retweet / post compartido)", () => {
    const crudos: RawDomPost[] = [
      { url: "https://x.com/bancosol/status/1", texto: "propio", fechaIso: null, imagenes: [], videos: [], autor: "bancosol" },
      { url: "https://x.com/otrobanco/status/2", texto: "ajeno", fechaIso: null, imagenes: [], videos: [], autor: "otrobanco" },
    ];
    const posts = parseDomPosts(crudos, "x", "bancosol");
    expect(posts).toHaveLength(1);
    expect(posts[0].caption).toBe("propio");
  });

  it("descarta un post sin autor identificable (fail-closed)", () => {
    const crudos: RawDomPost[] = [
      { url: "https://x.com/bancosol/status/1", texto: "sin autor", fechaIso: null, imagenes: [], videos: [], autor: null },
    ];
    expect(parseDomPosts(crudos, "x", "bancosol")).toEqual([]);
  });

  it("descarta un post con autor string vacío (fail-closed, no matchea handle vacío)", () => {
    const crudos: RawDomPost[] = [
      { url: "https://x.com/bancosol/status/1", texto: "autor vacío", fechaIso: null, imagenes: [], videos: [], autor: "" },
    ];
    expect(parseDomPosts(crudos, "x", "bancosol")).toEqual([]);
  });

  it("nunca matchea si el handle scrapeado está vacío, aunque el autor también lo esté", () => {
    const crudos: RawDomPost[] = [
      { url: "https://x.com//status/1", texto: "sin handle", fechaIso: null, imagenes: [], videos: [], autor: "" },
    ];
    expect(parseDomPosts(crudos, "x", "")).toEqual([]);
  });

  it("compara autor y handle sin distinguir mayúsculas/minúsculas", () => {
    const crudos: RawDomPost[] = [
      { url: "https://x.com/BancoSol/status/1", texto: "propio", fechaIso: null, imagenes: [], videos: [], autor: "BANCOSOL" },
    ];
    expect(parseDomPosts(crudos, "x", "bancosol")).toHaveLength(1);
  });

  it("matchea handles reales con punto y guion bajo tal cual, sin normalizar símbolos", () => {
    const crudos: RawDomPost[] = [
      { url: "https://facebook.com/altoke.bo/posts/1", texto: "post 1", fechaIso: null, imagenes: [], videos: [], autor: "altoke.bo" },
      { url: "https://facebook.com/bg.com.bo/posts/2", texto: "post 2", fechaIso: null, imagenes: [], videos: [], autor: "bg.com.bo" },
    ];
    expect(parseDomPosts(crudos, "facebook", "altoke.bo")).toHaveLength(1);
    expect(parseDomPosts(crudos, "facebook", "bg.com.bo")).toHaveLength(1);
  });

  it("descarta silenciosamente una fecha ISO inválida en vez de propagar el error", () => {
    const crudos: RawDomPost[] = [
      { url: "https://x.com/bancosol/status/1", texto: "fecha mala", fechaIso: "no-es-una-fecha", imagenes: [], videos: [], autor: "bancosol" },
    ];
    expect(parseDomPosts(crudos, "x", "bancosol")[0].fecha).toBeNull();
  });

  it("sin imágenes ni videos, mediaUrls queda vacío", () => {
    const crudos: RawDomPost[] = [
      { url: "https://x.com/bancosol/status/1", texto: "solo texto", fechaIso: null, imagenes: [], videos: [], autor: "bancosol" },
    ];
    expect(parseDomPosts(crudos, "x", "bancosol")[0].mediaUrls).toEqual([]);
  });

  it("BLOQUEANTE (revisión de calidad): convierte la fecha a calendario La Paz, no UTC — un post nocturno no salta al día siguiente", () => {
    // 2026-09-02T02:00:00.000Z son las 22:00 del 1/sep en La Paz (UTC-4). `.slice(0,10)` sobre el
    // ISO crudo daría "2026-09-02" (un día después del real) — el bug bloqueante reportado.
    const crudos: RawDomPost[] = [
      { url: "https://x.com/bancosol/status/1", texto: "post nocturno", fechaIso: "2026-09-02T02:00:00.000Z", imagenes: [], videos: [], autor: "bancosol" },
    ];
    expect(parseDomPosts(crudos, "x", "bancosol")[0].fecha).toBe("2026-09-01");
  });

  it("ordena más-reciente-primero aunque los posts crudos vengan desordenados (IMPORTANTE 4)", () => {
    const crudos: RawDomPost[] = [
      { url: "https://x.com/bancosol/status/1", texto: "viejo", fechaIso: "2026-09-01T10:00:00.000Z", imagenes: [], videos: [], autor: "bancosol" },
      { url: "https://x.com/bancosol/status/2", texto: "nuevo", fechaIso: "2026-09-03T10:00:00.000Z", imagenes: [], videos: [], autor: "bancosol" },
    ];
    const posts = parseDomPosts(crudos, "x", "bancosol");
    expect(posts.map((p) => p.caption)).toEqual(["nuevo", "viejo"]);
  });
});

describe("deriveAuthorFromPermalink", () => {
  it("caso normal de X: primer segmento de path es el autor", () => {
    expect(deriveAuthorFromPermalink("https://x.com/bancosol/status/123")).toBe("bancosol");
  });

  it("caso normal de Facebook: primer segmento de path es el autor", () => {
    expect(deriveAuthorFromPermalink("https://www.facebook.com/altoke.bo/posts/1")).toBe("altoke.bo");
  });

  it("Facebook /videos/ también matchea por el mismo criterio de primer segmento", () => {
    expect(deriveAuthorFromPermalink("https://www.facebook.com/bg.com.bo/videos/99")).toBe("bg.com.bo");
  });

  it("ignora la querystring — no afecta el primer segmento de path", () => {
    expect(deriveAuthorFromPermalink("https://x.com/bancosol/status/123?s=20&t=abc")).toBe("bancosol");
  });

  it("acepta una URL relativa (sin protocolo/host)", () => {
    expect(deriveAuthorFromPermalink("/bancosol/status/123")).toBe("bancosol");
  });

  it("caso de borde documentado: /i/web/status/{id} de X devuelve 'i' — acierto casual del primer segmento, no diseño verificado", () => {
    expect(deriveAuthorFromPermalink("https://x.com/i/web/status/123")).toBe("i");
  });

  it("permalink.php de Facebook no lleva el autor en el path — devuelve null explícito, no 'permalink.php'", () => {
    expect(deriveAuthorFromPermalink("https://www.facebook.com/permalink.php?story_fbid=123&id=456")).toBeNull();
  });

  it("descarta string vacío", () => {
    expect(deriveAuthorFromPermalink("")).toBeNull();
  });

  it("descarta una URL sin ningún segmento de path", () => {
    expect(deriveAuthorFromPermalink("https://x.com/")).toBeNull();
  });

  it("descarta una URL no parseable", () => {
    expect(deriveAuthorFromPermalink("http://[::1")).toBeNull();
  });
});
