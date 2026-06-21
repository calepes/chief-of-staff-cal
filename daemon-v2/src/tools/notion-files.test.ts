import { describe, it, expect } from "vitest";
import { collectAttachments } from "./notion-files.js";

describe("collectAttachments", () => {
  it("extrae un PDF desde una propiedad files", () => {
    const page = {
      properties: {
        Adjunto: {
          type: "files",
          files: [
            { type: "file", name: "vuelos.pdf", file: { url: "https://x.s3/vuelos.pdf?sig=1" } },
          ],
        },
      },
    };
    const out = collectAttachments(page, []);
    expect(out).toEqual([
      { url: "https://x.s3/vuelos.pdf?sig=1", name: "vuelos.pdf", isImage: false },
    ]);
  });

  it("extrae un PDF desde un bloque pdf", () => {
    const blocks = [
      { type: "pdf", pdf: { name: "ticket.pdf", file: { url: "https://x.s3/ticket.pdf?sig=2" } } },
    ];
    const out = collectAttachments({ properties: {} }, blocks);
    expect(out).toEqual([
      { url: "https://x.s3/ticket.pdf?sig=2", name: "ticket.pdf", isImage: false },
    ]);
  });

  it("marca isImage true para un bloque image", () => {
    const blocks = [
      { type: "image", image: { file: { url: "https://x.s3/foto.png?sig=3" } } },
    ];
    const out = collectAttachments({ properties: {} }, blocks);
    expect(out[0].isImage).toBe(true);
  });

  it("detecta imagen por extensión en URL con query string", () => {
    const page = {
      properties: {
        Foto: { type: "files", files: [{ type: "file", name: "", file: { url: "https://x.s3/a.JPG?sig=9" } }] },
      },
    };
    expect(collectAttachments(page, [])[0].isImage).toBe(true);
  });

  it("deduplica por url", () => {
    const page = {
      properties: { A: { type: "files", files: [{ type: "file", name: "d.pdf", file: { url: "https://x/d.pdf?s=1" } }] } },
    };
    const blocks = [{ type: "pdf", pdf: { name: "d.pdf", file: { url: "https://x/d.pdf?s=1" } } }];
    expect(collectAttachments(page, blocks)).toHaveLength(1);
  });

  it("devuelve [] cuando no hay adjuntos", () => {
    expect(collectAttachments({ properties: { Titulo: { type: "title", title: [] } } }, [])).toEqual([]);
  });
});
