import { describe, expect, it } from "vitest";
import { __serializeBodyForTest as serializeBody } from "./notion-cli.js";

describe("serializeBody — body de ntn api", () => {
  it("stringifica un objeto (el caso documentado en el schema)", () => {
    expect(serializeBody({ page_size: 100 })).toBe('{"page_size":100}');
  });

  it("pasa tal cual un string que YA es JSON válido (sin doble encode)", () => {
    // Regresión del bug real: dos turnos de Cal (2026-07-27) con 14 llamadas fallidas porque
    // el modelo manda el body como string y JSON.stringify lo envolvía otra vez.
    const raw = '{"page_size": 100, "sorts": [{"property": "Fecha", "direction": "ascending"}]}';
    expect(serializeBody(raw)).toBe(raw);
  });

  it("NO produce un string JSON-de-JSON", () => {
    const out = serializeBody('{"a":1}');
    expect(out).not.toBe('"{\\"a\\":1}"');
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });

  it("acepta un array JSON como string", () => {
    expect(serializeBody("[1,2,3]")).toBe("[1,2,3]");
  });

  it("stringifica un string que NO es JSON (ahí la intención sí era un literal)", () => {
    expect(serializeBody("hola")).toBe('"hola"');
  });

  it("stringifica objetos anidados sin tocarlos", () => {
    const obj = { filter: { property: "Fecha", date: { on_or_after: "2026-07-01" } } };
    expect(JSON.parse(serializeBody(obj))).toEqual(obj);
  });

  it("maneja el body vacío que el modelo manda como '{}'", () => {
    expect(serializeBody("{}")).toBe("{}");
    expect(serializeBody({})).toBe("{}");
  });
});
