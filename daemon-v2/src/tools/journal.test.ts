import { describe, it, expect } from "vitest";
import { resolveRefs, parseUnreviewedRows } from "./journal.js";

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
