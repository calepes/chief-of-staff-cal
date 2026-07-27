import { describe, it, expect, vi } from "vitest";
import {
  hasDnTag,
  stripDnTag,
  htmlToMarkdown,
  parseInlineMarkdown,
  textToParagraphBlocks,
  createDailyNotePage,
} from "./daily-note-ingest.js";

describe("hasDnTag", () => {
  it("detecta (DN) mayúscula", () => {
    expect(hasDnTag("(DN) Funcionalidades de Pagos Yape Bolivia")).toBe(true);
  });

  it("detecta (dn) minúscula", () => {
    expect(hasDnTag("RV: (dn) reunión con Riesgos")).toBe(true);
  });

  it("no detecta subjects sin el tag", () => {
    expect(hasDnTag("RV: Seguimiento Diario Yape Bolivia | 26/07/2026")).toBe(false);
  });
});

describe("stripDnTag", () => {
  it("quita el tag y espacios sobrantes", () => {
    expect(stripDnTag("(DN)  Funcionalidades de Pagos Yape Bolivia - Informe final")).toBe(
      "Funcionalidades de Pagos Yape Bolivia - Informe final",
    );
  });

  it("funciona con el tag en minúscula y en medio del subject", () => {
    expect(stripDnTag("RV: (dn) reunión con Riesgos")).toBe("RV: reunión con Riesgos");
  });

  it("no rompe un subject sin el tag", () => {
    expect(stripDnTag("Sin tag acá")).toBe("Sin tag acá");
  });
});

describe("htmlToMarkdown", () => {
  it("preserva links como [texto](url)", () => {
    const html = '<p>Mirá <a href="https://x.com/doc">el documento</a> por favor.</p>';
    expect(htmlToMarkdown(html)).toBe("Mirá [el documento](https://x.com/doc) por favor.");
  });

  it("convierte bold/italic a markdown", () => {
    const html = "<p>Esto es <b>importante</b> y esto <i>aclara</i>.</p>";
    expect(htmlToMarkdown(html)).toBe("Esto es **importante** y esto _aclara_.");
  });

  it("convierte <br> y cierres de bloque a saltos de línea", () => {
    const html = "<p>Línea 1<br>Línea 2</p><p>Otro párrafo</p>";
    expect(htmlToMarkdown(html)).toBe("Línea 1\nLínea 2\n\nOtro párrafo");
  });

  it("decodifica entidades comunes", () => {
    expect(htmlToMarkdown("<p>A &amp; B &lt;tag&gt; &quot;cita&quot; &#39;ap&#39;</p>")).toBe(`A & B <tag> "cita" 'ap'`);
  });

  it("quita <style>/<script> completos", () => {
    const html = "<style>.x{color:red}</style><p>texto</p><script>alert(1)</script>";
    expect(htmlToMarkdown(html)).toBe("texto");
  });

  it("no confunde <br> con <b> ni <link> con <li> (colisión de prefijo de nombre de tag)", () => {
    expect(htmlToMarkdown("<b>bold</b><br>siguiente")).toBe("**bold**\nsiguiente");
    expect(htmlToMarkdown("<ul><li>item</li></ul>")).toContain("- item");
  });

  it("un link con tags anidados adentro conserva el texto limpio", () => {
    const html = '<a href="https://x.com"><b>Texto</b> con bold</a>';
    expect(htmlToMarkdown(html)).toBe("[Texto con bold](https://x.com)");
  });
});

describe("parseInlineMarkdown", () => {
  it("texto sin markdown queda como un solo run plano", () => {
    const items = parseInlineMarkdown("texto normal sin nada especial");
    expect(items).toEqual([{ type: "text", text: { content: "texto normal sin nada especial" } }]);
  });

  it("**bold** se convierte en un run con annotations.bold, no queda como asteriscos literales", () => {
    const items = parseInlineMarkdown("Hola **De:** Nadia");
    expect(items).toEqual([
      { type: "text", text: { content: "Hola " } },
      { type: "text", text: { content: "De:" }, annotations: { bold: true } },
      { type: "text", text: { content: " Nadia" } },
    ]);
  });

  it("[texto](url) se convierte en un run con link real, no queda como corchetes literales", () => {
    const items = parseInlineMarkdown("Mirá [el doc](https://x.com/doc) porfa");
    expect(items).toEqual([
      { type: "text", text: { content: "Mirá " } },
      { type: "text", text: { content: "el doc", link: { url: "https://x.com/doc" } } },
      { type: "text", text: { content: " porfa" } },
    ]);
  });

  it("_italic_ se convierte en un run con annotations.italic", () => {
    const items = parseInlineMarkdown("esto _aclara_ algo");
    expect(items).toEqual([
      { type: "text", text: { content: "esto " } },
      { type: "text", text: { content: "aclara" }, annotations: { italic: true } },
      { type: "text", text: { content: " algo" } },
    ]);
  });

  it("combina bold + link en el mismo texto", () => {
    const items = parseInlineMarkdown("**De:** Nadia <[a](mailto:a@b.com)>");
    expect(items[0]).toEqual({ type: "text", text: { content: "De:" }, annotations: { bold: true } });
    expect(items.some((i) => i.text.link?.url === "mailto:a@b.com")).toBe(true);
  });

  it("no interpreta un underscore aislado (sin par) como italic", () => {
    const items = parseInlineMarkdown("archivo_final.pdf sin otro underscore");
    expect(items).toEqual([{ type: "text", text: { content: "archivo_final.pdf sin otro underscore" } }]);
  });
});

describe("textToParagraphBlocks", () => {
  it("resuelve el markdown inline de cada párrafo a runs anotados (no texto literal con ** o [])", () => {
    const blocks = textToParagraphBlocks("**De:** Nadia\n\nMirá [el doc](https://x.com/doc).");
    expect(blocks[0].paragraph.rich_text).toEqual([
      { type: "text", text: { content: "De:" }, annotations: { bold: true } },
      { type: "text", text: { content: " Nadia" } },
    ]);
    expect(blocks[1].paragraph.rich_text).toEqual([
      { type: "text", text: { content: "Mirá " } },
      { type: "text", text: { content: "el doc", link: { url: "https://x.com/doc" } } },
      { type: "text", text: { content: "." } },
    ]);
  });
});

describe("textToParagraphBlocks (chunking)", () => {
  it("un bloque por párrafo separado por línea en blanco", () => {
    const blocks = textToParagraphBlocks("Párrafo uno.\n\nPárrafo dos.");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].paragraph.rich_text[0].text.content).toBe("Párrafo uno.");
    expect(blocks[1].paragraph.rich_text[0].text.content).toBe("Párrafo dos.");
  });

  it("los \\n simples quedan dentro del mismo bloque", () => {
    const blocks = textToParagraphBlocks("Línea A\nLínea B");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].paragraph.rich_text[0].text.content).toBe("Línea A\nLínea B");
  });

  it("ignora párrafos vacíos (líneas en blanco de sobra)", () => {
    const blocks = textToParagraphBlocks("Uno\n\n\n\nDos");
    expect(blocks).toHaveLength(2);
  });

  it("parte un párrafo que excede el límite de un rich_text en varios bloques", () => {
    const long = "a".repeat(2500);
    const blocks = textToParagraphBlocks(long);
    expect(blocks.length).toBe(2);
    expect(blocks[0].paragraph.rich_text[0].text.content.length).toBe(1900);
    expect(blocks[1].paragraph.rich_text[0].text.content.length).toBe(600);
  });

  it("string vacío no genera bloques", () => {
    expect(textToParagraphBlocks("   \n\n  ")).toEqual([]);
  });
});

describe("createDailyNotePage", () => {
  it("crea la página con Name/Date y los bloques del body inline", async () => {
    const calls: Array<{ method: string; url: string; body: any }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method: init?.method ?? "GET", url: String(url), body });
      return new Response(JSON.stringify({ id: "page-123" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await createDailyNotePage(
      "tok",
      { title: "Funcionalidades de Pagos Yape Bolivia", fecha: "2026-07-27", bodyMarkdown: "Hola.\n\nSegundo párrafo." },
      fetchFn,
    );

    expect(result).toEqual({ pageId: "page-123" });
    const createCall = calls.find((c) => c.url.endsWith("/v1/pages"));
    expect(createCall?.body.parent).toEqual({ database_id: "156c4876-09dd-8051-8154-c82769a316a5" });
    expect(createCall?.body.properties.Name).toEqual({ title: [{ text: { content: "Funcionalidades de Pagos Yape Bolivia" } }] });
    expect(createCall?.body.properties.Date).toEqual({ date: { start: "2026-07-27" } });
    expect(createCall?.body.children).toHaveLength(2);
  });

  it("hace PATCH adicionales si hay más de 100 bloques", async () => {
    const calls: Array<{ method: string; url: string; body: any }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method: init?.method ?? "GET", url: String(url), body });
      return new Response(JSON.stringify({ id: "page-456" }), { status: 200 });
    }) as unknown as typeof fetch;

    const manyParagraphs = Array.from({ length: 130 }, (_, i) => `Párrafo ${i}`).join("\n\n");
    await createDailyNotePage("tok", { title: "T", fecha: "2026-07-27", bodyMarkdown: manyParagraphs }, fetchFn);

    const createCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/pages"));
    expect(createCall?.body.children).toHaveLength(100);
    const patchCalls = calls.filter((c) => c.method === "PATCH");
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].body.children).toHaveLength(30);
    expect(patchCalls[0].url).toContain("/v1/blocks/page-456/children");
  });

  it("lanza si Notion devuelve error", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(createDailyNotePage("tok", { title: "T", fecha: "2026-07-27", bodyMarkdown: "x" }, fetchFn)).rejects.toThrow("401");
  });
});
