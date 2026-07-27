import { describe, it, expect } from "vitest";
import {
  buildEntryProperties,
  buildBodyBlocks,
  buildMetadataProperties,
  buildResonateProperties,
  buildQuoteBlocks,
} from "./journal-payloads.js";

describe("buildEntryProperties", () => {
  it("arma la fila cruda con estado Sin revisar", () => {
    const props = buildEntryProperties({
      texto: "hoy me sentí raro en la reunión",
      origen: "Voz",
      fechaHora: "2026-07-27T14:32:00-04:00",
    });
    expect(props["Origen"]).toEqual({ select: { name: "Voz" } });
    expect(props["Estado"]).toEqual({ select: { name: "Sin revisar" } });
    expect(props["Fecha y hora"]).toEqual({ date: { start: "2026-07-27T14:32:00-04:00" } });
    expect(props["Extracto"]).toEqual({
      rich_text: [{ text: { content: "hoy me sentí raro en la reunión" } }],
    });
  });

  it("usa el extracto como título provisional para que la fila no quede sin nombre", () => {
    const props = buildEntryProperties({
      texto: "a".repeat(500),
      origen: "Texto",
      fechaHora: "2026-07-27T14:32:00-04:00",
    });
    const title = props["Pensamiento"] as { title: Array<{ text: { content: string } }> };
    expect(title.title[0]!.text.content.endsWith("…")).toBe(true);
    expect(title.title[0]!.text.content.length).toBeLessThanOrEqual(201);
  });
});

describe("buildBodyBlocks", () => {
  it("convierte el texto en bloques paragraph", () => {
    expect(buildBodyBlocks("uno\n\ndos")).toEqual([
      { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "uno" } }] } },
      { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "dos" } }] } },
    ]);
  });
});

describe("buildMetadataProperties", () => {
  it("escribe título, ánimo, intensidad y relaciones", () => {
    const props = buildMetadataProperties({
      titulo: "Miedo a la confrontación",
      animo: "😤 Tensionado",
      intensidad: 4,
      topics: [{ id: "t1", name: "Terapia" }, { id: "t2", name: "Autoestima" }],
      bigTheme: { id: "b1", name: "Better Me" },
    });
    expect(props["Pensamiento"]).toEqual({
      title: [{ text: { content: "Miedo a la confrontación" } }],
    });
    expect(props["Ánimo"]).toEqual({ select: { name: "😤 Tensionado" } });
    expect(props["Intensidad"]).toEqual({ number: 4 });
    expect(props["Topics"]).toEqual({ relation: [{ id: "t1" }, { id: "t2" }] });
    expect(props["Big Themes"]).toEqual({ relation: [{ id: "b1" }] });
  });

  it("manda relación vacía cuando no hay big theme", () => {
    const props = buildMetadataProperties({
      titulo: "x",
      animo: "😐 Neutro",
      intensidad: 3,
      topics: [],
      bigTheme: null,
    });
    expect(props["Big Themes"]).toEqual({ relation: [] });
    expect(props["Topics"]).toEqual({ relation: [] });
  });
});

describe("buildResonateProperties", () => {
  it("arma la fila de Resonate con Type Reflexion y Tag Terapia", () => {
    const props = buildResonateProperties({
      titulo: "Un amigo hombre con quien conversar",
      situacion: "Sesión con Valeria",
      fecha: "2026-07-27",
      topics: [{ id: "t1", name: "Terapia" }],
      bigTheme: { id: "b1", name: "Better Me" },
      entryId: "e1",
    });
    expect(props["Name"]).toEqual({
      title: [{ text: { content: "Un amigo hombre con quien conversar" } }],
    });
    expect(props["Type"]).toEqual({ select: { name: "Reflexion" } });
    expect(props["Tags"]).toEqual({ multi_select: [{ name: "Terapia" }] });
    expect(props["Fecha"]).toEqual({ date: { start: "2026-07-27" } });
    expect(props["Situacion"]).toEqual({ rich_text: [{ text: { content: "Sesión con Valeria" } }] });
    expect(props["Journal"]).toEqual({ relation: [{ id: "e1" }] });
  });

  it("omite Situacion cuando viene vacía", () => {
    const props = buildResonateProperties({
      titulo: "x",
      situacion: "",
      fecha: "2026-07-27",
      topics: [],
      bigTheme: null,
      entryId: "e1",
    });
    expect(props["Situacion"]).toBeUndefined();
  });
});

describe("buildQuoteBlocks", () => {
  it("copia el texto crudo como quote", () => {
    const blocks = buildQuoteBlocks("pensamiento original");
    expect(blocks[0]).toEqual({
      object: "block",
      type: "quote",
      quote: { rich_text: [{ type: "text", text: { content: "pensamiento original" } }] },
    });
  });
});
