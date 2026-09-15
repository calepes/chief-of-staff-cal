import { describe, it, expect } from "vitest";
import { buildResumenHeader, buildQueueSelector, classifyArticleAccess, fetchArticleForSummary } from "./resumir.js";
import type { CfKv } from "../cf-kv.js";
import type { FetchAsUserResult } from "./fetch-as-user.js";

// Solo se testean las funciones PURAS (sin I/O: subprocess/filesystem/red). El resto de
// resumir.ts (extracción vía yt-dlp/whisper/safari-fetch/Feedbin, selección real de la cola en
// disco) se verifica con build limpio + prueba manual, mismo criterio que el resto del archivo
// hoy (sin infraestructura de mocks para subprocess/filesystem en este repo).

describe("buildResumenHeader", () => {
  it("título + autor (video): antepone título en <b> y canal con emoji 🎬", () => {
    const out = buildResumenHeader("Cómo aprender TypeScript", "Fireship", "video");
    expect(out).toBe("<b>Cómo aprender TypeScript</b>\n🎬 Fireship\n\n");
  });

  it("título + autor (article): usa emoji 📰", () => {
    const out = buildResumenHeader("El futuro del trabajo remoto", "The Economist", "article");
    expect(out).toBe("<b>El futuro del trabajo remoto</b>\n📰 The Economist\n\n");
  });

  it("título + autor (podcast): usa el mismo emoji 🎬 que video", () => {
    const out = buildResumenHeader("Episodio 42", "Radio Ambulante", "podcast");
    expect(out).toBe("<b>Episodio 42</b>\n🎬 Radio Ambulante\n\n");
  });

  it("solo título (sin autor): una sola línea, sin línea de emoji", () => {
    const out = buildResumenHeader("Un libro sin autor estructurado", undefined, "book");
    expect(out).toBe("<b>Un libro sin autor estructurado</b>\n\n");
  });

  it("solo autor (sin título): una sola línea con emoji, sin <b>", () => {
    const out = buildResumenHeader(undefined, "Some Channel", "video");
    expect(out).toBe("🎬 Some Channel\n\n");
  });

  it("ninguno de los dos: string vacío", () => {
    expect(buildResumenHeader(undefined, undefined, "book")).toBe("");
    expect(buildResumenHeader("", "", "article")).toBe("");
  });

  it("escapa HTML en título y autor (evita romper el parse_mode HTML de Telegram)", () => {
    const out = buildResumenHeader("<script>alert(1)</script>", "A & B", "article");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("A &amp; B");
  });

  it("trimea espacios sobrantes en título/autor", () => {
    const out = buildResumenHeader("  Título con espacios  ", "  Canal  ", "video");
    expect(out).toBe("<b>Título con espacios</b>\n🎬 Canal\n\n");
  });
});

describe("buildQueueSelector", () => {
  it("1 item: header con conteo 1, una línea numerada, botón del item + fila final", () => {
    const sel = buildQueueSelector("v", [{ id: "abc123", title: "Un video cualquiera" }]);
    expect(sel.text).toContain("🎬 <b>1 video(s)");
    expect(sel.text).toContain("1. Un video cualquiera");
    const kb = sel.keyboard as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    expect(kb.inline_keyboard).toHaveLength(2); // fila del item + fila final
    expect(kb.inline_keyboard[0]).toEqual([{ text: "1", callback_data: "resu-pick:v:abc123" }]);
    expect(kb.inline_keyboard[1]).toEqual([
      { text: "✅ Procesar todos", callback_data: "resu-pick:v:all" },
      { text: "❌ Ahora no", callback_data: "resu-pick:v:none" },
    ]);
  });

  it("6+ items: filas de máx 5 botones numerados + fila final aparte", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `id${i}`, title: `Item ${i}` }));
    const sel = buildQueueSelector("s", items);
    const kb = sel.keyboard as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    // 7 botones numerados → 2 filas (5 + 2) + 1 fila final = 3 filas
    expect(kb.inline_keyboard).toHaveLength(3);
    expect(kb.inline_keyboard[0]).toHaveLength(5);
    expect(kb.inline_keyboard[1]).toHaveLength(2);
    expect(kb.inline_keyboard[2]).toHaveLength(2); // Procesar todos + Ahora no
    expect(sel.text).toContain("⭐ <b>7 starred");
    expect(sel.text).toContain("1. Item 0");
    expect(sel.text).toContain("7. Item 6");
  });

  it("ids string (playlist) vs number (starred) fluyen igual en el callback_data", () => {
    const selV = buildQueueSelector("v", [{ id: "dQw4w9WgXcQ", title: "Video" }]);
    const kbV = selV.keyboard as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    expect(kbV.inline_keyboard[0][0].callback_data).toBe("resu-pick:v:dQw4w9WgXcQ");

    const selS = buildQueueSelector("s", [{ id: 987654, title: "Artículo" }]);
    const kbS = selS.keyboard as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    expect(kbS.inline_keyboard[0][0].callback_data).toBe("resu-pick:s:987654");
  });

  it("0 items: no explota, arma solo la fila final", () => {
    const sel = buildQueueSelector("v", []);
    const kb = sel.keyboard as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    expect(kb.inline_keyboard).toHaveLength(1);
    expect(kb.inline_keyboard[0]).toEqual([
      { text: "✅ Procesar todos", callback_data: "resu-pick:v:all" },
      { text: "❌ Ahora no", callback_data: "resu-pick:v:none" },
    ]);
    expect(sel.text).toContain("0 video(s)");
  });

  it("recorta títulos largos a ~80 chars", () => {
    const longTitle = "T".repeat(200);
    const sel = buildQueueSelector("v", [{ id: "x", title: longTitle }]);
    const firstLine = sel.text.split("\n").find((l) => l.startsWith("1. "))!;
    // "1. " (3 chars) + hasta 80 chars de título
    expect(firstLine.length).toBeLessThanOrEqual(3 + 80);
  });
});

describe("classifyArticleAccess", () => {
  it("pide sesión cuando el contenido es corto y no se usó ninguna cookie", () => {
    expect(classifyArticleAccess("Introducción breve", 0)).toBe("needs-session");
  });

  it("rechaza una pantalla Members Only aunque se haya enviado una cookie", () => {
    const blocked = "Introducción. Members Only content. If you have an account, log in here.";
    expect(classifyArticleAccess(blocked, 2)).toBe("session-not-unlocked");
  });

  it("permite contenido completo cuando la sesión sí desbloqueó el artículo", () => {
    expect(classifyArticleAccess("Contenido completo ".repeat(200), 2)).toBe("ok");
  });
});

describe("fetchArticleForSummary", () => {
  it("usa la transcripción autenticada cuando la página de un podcast de fs.blog sigue mostrando el paywall", async () => {
    const source = "https://fs.blog/knowledge-project-podcast/tobi-lutke-3/";
    const transcript = "https://fs.blog/knowledge-project-podcast-transcripts/tobi-lutke-3/";
    const requested: string[] = [];
    const fetcher = async (url: string): Promise<FetchAsUserResult> => {
      requested.push(url);
      if (url === source) {
        return {
          ok: true,
          status: 200,
          url,
          cookiesUsed: 7,
          text: "Public Release. Members Only content. Become a Member.",
          title: "Tobi Lütke",
          domainWhitelisted: true,
        };
      }
      return {
        ok: true,
        status: 200,
        url,
        cookiesUsed: 7,
        text: "Shane Parrish: Tobi, welcome back. ".repeat(100),
        title: "Tobi Lütke transcript",
        domainWhitelisted: true,
      };
    };

    const result = await fetchArticleForSummary(source, {} as CfKv, fetcher);

    expect(requested).toEqual([source, transcript]);
    expect(result.source).toBe(transcript);
    expect(result.result.text).toContain("Shane Parrish: Tobi, welcome back.");
    expect(classifyArticleAccess(result.result.text, result.result.cookiesUsed)).toBe("ok");
  });
});
