import { afterEach, describe, expect, it } from "vitest";
import { defaultEffort, effortForMessage } from "./effort.js";

describe("effortForMessage", () => {
  it("usa el effort por defecto en un mensaje normal", () => {
    const r = effortForMessage("¿qué tengo en la agenda hoy?");
    expect(r.effort).toBe(defaultEffort());
    expect(r.text).toBe("¿qué tengo en la agenda hoy?");
  });

  it("sube a xhigh con /deep y saca el prefijo del mensaje", () => {
    const r = effortForMessage("/deep proyectá cuándo llegamos a 5MM");
    expect(r.effort).toBe("xhigh");
    expect(r.text).toBe("proyectá cuándo llegamos a 5MM");
  });

  it("acepta /fondo y ++ como alias", () => {
    expect(effortForMessage("/fondo analizá esto").effort).toBe("xhigh");
    expect(effortForMessage("++ analizá esto").effort).toBe("xhigh");
    expect(effortForMessage("++analizá esto").text).toBe("analizá esto");
  });

  it("es case-insensitive y tolera espacios antes del prefijo", () => {
    const r = effortForMessage("  /DEEP dame los sábados");
    expect(r.effort).toBe("xhigh");
    expect(r.text).toBe("dame los sábados");
  });

  it("no confunde un prefijo que aparece a mitad del mensaje", () => {
    const r = effortForMessage("mandale un mensaje que diga /deep");
    expect(r.effort).toBe(defaultEffort());
    expect(r.text).toBe("mandale un mensaje que diga /deep");
  });

  it("no rompe con un mensaje vacío", () => {
    expect(effortForMessage("").text).toBe("");
    expect(effortForMessage("").effort).toBe(defaultEffort());
  });

  it("deja el mensaje vacío si Cal manda solo el prefijo", () => {
    const r = effortForMessage("/deep");
    expect(r.effort).toBe("xhigh");
    expect(r.text).toBe("");
  });
});

describe("defaultEffort", () => {
  const original = process.env.JANO_EFFORT;
  afterEach(() => {
    if (original === undefined) delete process.env.JANO_EFFORT;
    else process.env.JANO_EFFORT = original;
  });

  it("cae a high sin la env var", () => {
    delete process.env.JANO_EFFORT;
    expect(defaultEffort()).toBe("high");
  });

  it("respeta un valor válido de la env var", () => {
    process.env.JANO_EFFORT = "medium";
    expect(defaultEffort()).toBe("medium");
  });

  it("lee la env var EN CADA LLAMADA, no al cargar el módulo", () => {
    // Esto es el fix de W2: como `const` de módulo, el valor se congelaba antes de que
    // index.ts corriera loadEnv(), así que JANO_EFFORT en el .env se ignoraba en silencio.
    delete process.env.JANO_EFFORT;
    expect(defaultEffort()).toBe("high");
    process.env.JANO_EFFORT = "max";
    expect(defaultEffort()).toBe("max");
  });

  it("descarta un valor inválido y cae a high en vez de pasárselo al SDK", () => {
    process.env.JANO_EFFORT = "higth";
    expect(defaultEffort()).toBe("high");
  });

  it("trata la env var vacía como ausente", () => {
    process.env.JANO_EFFORT = "";
    expect(defaultEffort()).toBe("high");
  });
});
