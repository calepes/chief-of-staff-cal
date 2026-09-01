import { describe, it, expect } from "vitest";
import { ENTITIES, getEntity } from "./research-competencia-entities.js";

describe("research-competencia-entities", () => {
  it("tiene exactamente 6 entidades con ids únicos", () => {
    expect(ENTITIES).toHaveLength(6);
    const ids = ENTITIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(6);
  });

  it("cada entidad tiene al menos una fuente mecánica configurada (iOS, Android o sitio)", () => {
    for (const e of ENTITIES) {
      expect(e.ios || e.android || e.siteUrl).toBeTruthy();
    }
  });

  it("getEntity devuelve la entidad por id", () => {
    expect(getEntity("takenos").nombre).toBe("Takenos");
  });

  it("getEntity tira si el id no existe", () => {
    expect(() => getEntity("no-existe")).toThrow("Entidad desconocida: no-existe");
  });
});
