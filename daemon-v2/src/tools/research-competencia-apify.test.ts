import { describe, it, expect } from "vitest";
import { parseFacebookApifyItems, parseTikTokApifyItems } from "./research-competencia-apify.js";

/** Item real de `apify~facebook-posts-scraper` (capturado en vivo 2026-09-05, recortado a lo
 * relevante) contra altoke.bo. */
function facebookItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    facebookUrl: "https://www.facebook.com/altoke.bo",
    postId: "122313061682219157",
    pageName: "altoke.bo",
    url: "https://www.facebook.com/altoke.bo/posts/pfbid02difSgxErAxAfqtcR5PoD9SZcGDUbBPGfhgdcMnUDL4xvE7P5k5khd63ZqXTq3PnAl",
    time: "2026-09-05T14:00:05.000Z",
    timestamp: 1788616805,
    user: { id: "61556574716590", name: "altoke", profileUrl: "https://www.facebook.com/61556574716590" },
    text: "💰✨ Tu esfuerzo por ahorrar puede tener recompensa.\n\nIncrementa tus ahorros este mes en altoke...",
    likes: 7,
    comments: 10,
    shares: 1,
    media: [{ thumbnail: "https://scontent.../foto.jpg", __typename: "Photo", photo_image: { uri: "https://scontent.../foto_full.jpg" } }],
    ...overrides,
  };
}

describe("parseFacebookApifyItems", () => {
  it("parsea un item real: fecha La Paz, caption, imagen full-res, esVideo false", () => {
    const posts = parseFacebookApifyItems([facebookItem()], "altoke.bo");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      platform: "facebook",
      handle: "altoke.bo",
      url: "https://www.facebook.com/altoke.bo/posts/pfbid02difSgxErAxAfqtcR5PoD9SZcGDUbBPGfhgdcMnUDL4xvE7P5k5khd63ZqXTq3PnAl",
      caption: "💰✨ Tu esfuerzo por ahorrar puede tener recompensa.\n\nIncrementa tus ahorros este mes en altoke...",
      mediaUrls: ["https://scontent.../foto_full.jpg"],
      esVideo: false,
    });
    // 14:00:05Z → 10:00:05 La Paz, mismo día calendario.
    expect(posts[0].fecha).toBe("2026-09-05");
  });

  it("cae a thumbnail si no hay photo_image.uri", () => {
    const posts = parseFacebookApifyItems(
      [facebookItem({ media: [{ thumbnail: "https://scontent.../thumb.jpg" }] })],
      "altoke.bo",
    );
    expect(posts[0].mediaUrls).toEqual(["https://scontent.../thumb.jpg"]);
  });

  it("mediaUrls vacío si no hay media", () => {
    const posts = parseFacebookApifyItems([facebookItem({ media: [] })], "altoke.bo");
    expect(posts[0].mediaUrls).toEqual([]);
  });

  it("descarta un item cuyo pageName no matchea el handle configurado (fail-closed)", () => {
    const posts = parseFacebookApifyItems([facebookItem({ pageName: "otra-pagina" })], "altoke.bo");
    expect(posts).toEqual([]);
  });

  it("compara pageName y handle sin distinguir mayúsculas/minúsculas", () => {
    const posts = parseFacebookApifyItems([facebookItem({ pageName: "ALTOKE.BO" })], "altoke.bo");
    expect(posts).toHaveLength(1);
  });

  it("descarta un item sin url", () => {
    const posts = parseFacebookApifyItems([facebookItem({ url: undefined })], "altoke.bo");
    expect(posts).toEqual([]);
  });

  it("caption vacío si falta text, fecha null si time no es un string parseable", () => {
    const posts = parseFacebookApifyItems([facebookItem({ text: undefined, time: "no-es-fecha" })], "altoke.bo");
    expect(posts[0].caption).toBe("");
    expect(posts[0].fecha).toBeNull();
  });

  it("lista vacía sin items", () => {
    expect(parseFacebookApifyItems([], "altoke.bo")).toEqual([]);
  });
});

/** Item real de `apidojo~tiktok-scraper` (capturado en vivo 2026-09-05, recortado a lo relevante). */
function tiktokItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inputSource: "https://www.tiktok.com/@khaby.lame",
    id: "7681719358225239326",
    title: "Well… that didn't go as planned #learnfromkhaby #comedy",
    views: 2104626,
    likes: 301064,
    comments: 6768,
    shares: 5047,
    channel: { id: "127905465618821121", name: "Khabane lame", username: "khaby.lame", followers: 162764703, videos: 1352 },
    uploadedAt: 1788539684,
    uploadedAtFormatted: "2026-09-04T16:34:44.000Z",
    video: { width: 720, height: 1280, duration: 48.674, url: "https://v16m.tiktokcdn-us.com/.../video.mp4" },
    ...overrides,
  };
}

describe("parseTikTokApifyItems", () => {
  it("parsea un item real: caption, video real, esVideo true", () => {
    const posts = parseTikTokApifyItems([tiktokItem()], "khaby.lame");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      platform: "tiktok",
      handle: "khaby.lame",
      url: "https://www.tiktok.com/@khaby.lame/video/7681719358225239326",
      caption: "Well… that didn't go as planned #learnfromkhaby #comedy",
      mediaUrls: ["https://v16m.tiktokcdn-us.com/.../video.mp4"],
      esVideo: true,
    });
    expect(posts[0].fecha).toBe("2026-09-04");
  });

  it("ignora explícitamente { noResults: true } como 0 items, no como item malformado", () => {
    expect(parseTikTokApifyItems([{ noResults: true }], "khaby.lame")).toEqual([]);
  });

  it("GRAVE: descarta contenido de otra cuenta devuelto por el actor (caso real takenos_app_bo)", () => {
    // Verificado en vivo 2026-09-05: pedir takenos_app_bo devolvió videos de luisfer.sarabia y
    // rodrigolo_ — sin la validación de autoría, esos items se atribuirían igual al handle pedido.
    const ajeno = tiktokItem({ id: "1", channel: { username: "luisfer.sarabia" } });
    expect(parseTikTokApifyItems([ajeno], "takenos_app_bo")).toEqual([]);
  });

  it("compara channel.username y handle sin distinguir mayúsculas/minúsculas", () => {
    const posts = parseTikTokApifyItems([tiktokItem({ channel: { username: "Khaby.Lame" } })], "khaby.lame");
    expect(posts).toHaveLength(1);
  });

  it("descarta un item sin id", () => {
    expect(parseTikTokApifyItems([tiktokItem({ id: undefined })], "khaby.lame")).toEqual([]);
  });

  it("caption vacío si falta title, mediaUrls vacío si falta video.url", () => {
    const posts = parseTikTokApifyItems([tiktokItem({ title: undefined, video: {} })], "khaby.lame");
    expect(posts[0].caption).toBe("");
    expect(posts[0].mediaUrls).toEqual([]);
  });

  it("ordena más-reciente-primero aunque los items crudos vengan desordenados", () => {
    const posts = parseTikTokApifyItems(
      [
        tiktokItem({ id: "viejo", uploadedAt: 1700000000, channel: { username: "khaby.lame" } }),
        tiktokItem({ id: "nuevo", uploadedAt: 1700259200, channel: { username: "khaby.lame" } }),
      ],
      "khaby.lame",
    );
    expect(posts.map((p) => p.url)).toEqual([
      "https://www.tiktok.com/@khaby.lame/video/nuevo",
      "https://www.tiktok.com/@khaby.lame/video/viejo",
    ]);
  });

  it("lista vacía sin items", () => {
    expect(parseTikTokApifyItems([], "khaby.lame")).toEqual([]);
  });
});
