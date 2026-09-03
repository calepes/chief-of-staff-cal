import { describe, it, expect } from "vitest";
import { parseInstagramPosts } from "./research-competencia-scrapers.js";

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
