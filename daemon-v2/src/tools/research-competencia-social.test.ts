import { describe, it, expect } from "vitest";
import { filterPostsByTimeframe, formatSocialText, type SocialPost, type EnrichedPost } from "./research-competencia-social.js";

function post(overrides: Partial<SocialPost> = {}): SocialPost {
  return {
    platform: "instagram", handle: "altoke.bo", url: "https://instagram.com/p/abc",
    fecha: "2026-09-01", caption: "Nueva promo", mediaUrls: [], esVideo: false,
    ...overrides,
  };
}

describe("filterPostsByTimeframe", () => {
  const ahora = new Date("2026-09-10T12:00:00Z");

  it("deja pasar un post dentro de la ventana", () => {
    expect(filterPostsByTimeframe([post({ fecha: "2026-09-08" })], 7, ahora)).toHaveLength(1);
  });

  it("descarta un post anterior a la ventana", () => {
    expect(filterPostsByTimeframe([post({ fecha: "2026-08-01" })], 7, ahora)).toHaveLength(0);
  });

  it("conserva posts sin fecha — mejor procesarlos que perder contenido reciente sin timestamp legible", () => {
    expect(filterPostsByTimeframe([post({ fecha: null })], 7, ahora)).toHaveLength(1);
  });
});

describe("formatSocialText", () => {
  it("incluye plataforma, handle, URL, caption, descripción de imagen y transcripción", () => {
    const enriched: EnrichedPost[] = [{
      ...post({ esVideo: true }),
      imagenes: ["Flyer con tarifa 0%"],
      video: { transcripcion: "Ahora podés pedir tu crédito", frames: ["Pantalla de la app con Bs 800"] },
    }];
    const text = formatSocialText(enriched);
    expect(text).toContain("instagram");
    expect(text).toContain("altoke.bo");
    expect(text).toContain("https://instagram.com/p/abc");
    expect(text).toContain("Nueva promo");
    expect(text).toContain("Flyer con tarifa 0%");
    expect(text).toContain("Ahora podés pedir tu crédito");
    expect(text).toContain("Pantalla de la app con Bs 800");
  });

  it("devuelve string vacío si no hay posts", () => {
    expect(formatSocialText([])).toBe("");
  });
});
