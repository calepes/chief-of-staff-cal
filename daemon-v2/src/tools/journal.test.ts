import { describe, it, expect } from "vitest";
import { resolveRefs, parseUnreviewedRows, compactJournalRows } from "./journal.js";

describe("resolveRefs", () => {
  const index = new Map([
    ["terapia", { id: "t1", name: "Terapia" }],
    ["autoestima", { id: "t2", name: "Autoestima" }],
  ]);

  it("resuelve nombres existentes sin distinguir mayúsculas", () => {
    expect(resolveRefs(["Terapia", "AUTOESTIMA"], index)).toEqual({
      encontrados: [
        { id: "t1", name: "Terapia" },
        { id: "t2", name: "Autoestima" },
      ],
      faltantes: [],
    });
  });

  it("reporta los nombres que no existen", () => {
    expect(resolveRefs(["Terapia", "Inventado"], index)).toEqual({
      encontrados: [{ id: "t1", name: "Terapia" }],
      faltantes: ["Inventado"],
    });
  });

  it("ignora duplicados", () => {
    expect(resolveRefs(["Terapia", "terapia"], index).encontrados).toHaveLength(1);
  });

  it("ignora nombres vacíos", () => {
    expect(resolveRefs(["  ", "Terapia"], index).faltantes).toEqual([]);
  });
});

describe("parseUnreviewedRows", () => {
  it("extrae id, título y fecha de la respuesta de Notion", () => {
    const res = {
      results: [
        {
          id: "e1",
          properties: {
            Pensamiento: { type: "title", title: [{ plain_text: "Miedo a la confrontación" }] },
            "Fecha y hora": { type: "date", date: { start: "2026-07-22T09:00:00-04:00" } },
          },
        },
      ],
    };
    expect(parseUnreviewedRows(res)).toEqual([
      { id: "e1", titulo: "Miedo a la confrontación", fecha: "2026-07-22T09:00:00-04:00" },
    ]);
  });

  it("usa un placeholder si la fila no tiene título", () => {
    const res = {
      results: [
        {
          id: "e1",
          properties: {
            Pensamiento: { type: "title", title: [] },
            "Fecha y hora": { type: "date", date: { start: "2026-07-22T09:00:00-04:00" } },
          },
        },
      ],
    };
    expect(parseUnreviewedRows(res)[0]!.titulo).toBe("(sin título)");
  });

  it("devuelve vacío si la respuesta no trae results", () => {
    expect(parseUnreviewedRows({ error: "boom" })).toEqual([]);
  });
});

describe("compactJournalRows", () => {
  const fila = {
    id: "e1",
    properties: {
      Pensamiento: { title: [{ plain_text: "Miedo a la confrontación" }] },
      "Fecha y hora": { date: { start: "2026-07-22T09:00:00-04:00" } },
      "Ánimo": { select: { name: "😤 Tensionado" } },
      Intensidad: { number: 4 },
      Estado: { select: { name: "Destilado" } },
      Extracto: { rich_text: [{ plain_text: "hoy en la sesión..." }] },
      // Ruido que NO debe salir: es lo que hace pesada la respuesta cruda.
      Topics: { relation: [{ id: "t1" }, { id: "t2" }] },
      "Big Themes": { relation: [{ id: "b1" }] },
    },
    url: "https://notion.so/e1",
    created_by: { id: "u1", object: "user" },
    parent: { database_id: "db1" },
  };

  it("deja solo los campos que el LLM necesita leer", () => {
    expect(compactJournalRows({ results: [fila] })).toEqual([
      {
        id: "e1",
        titulo: "Miedo a la confrontación",
        fecha: "2026-07-22T09:00:00-04:00",
        animo: "😤 Tensionado",
        intensidad: 4,
        estado: "Destilado",
        extracto: "hoy en la sesión...",
      },
    ]);
  });

  it("recorta el payload de forma significativa", () => {
    const crudo = JSON.stringify({ results: Array(15).fill(fila) }).length;
    const compacto = JSON.stringify(compactJournalRows({ results: Array(15).fill(fila) })).length;
    expect(compacto).toBeLessThan(crudo / 2);
  });

  it("tolera propiedades faltantes o nulas", () => {
    const out = compactJournalRows({
      results: [{ id: "e2", properties: { Pensamiento: { title: [] } } }],
    });
    expect(out[0]).toEqual({
      id: "e2",
      titulo: "(sin título)",
      fecha: "",
      animo: null,
      intensidad: null,
      estado: null,
      extracto: "",
    });
  });

  it("devuelve vacío si la respuesta no trae results", () => {
    expect(compactJournalRows({ error: "boom" })).toEqual([]);
  });
});
