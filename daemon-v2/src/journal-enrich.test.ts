import { describe, it, expect } from "vitest";
import { buildEnrichPrompt, parseEnrichResult } from "./journal-enrich.js";

describe("buildEnrichPrompt", () => {
  it("incluye el texto y los catálogos disponibles", () => {
    const prompt = buildEnrichPrompt("me sentí mal", ["Terapia", "Foco"], ["Better Me"]);
    expect(prompt).toContain("me sentí mal");
    expect(prompt).toContain("Terapia, Foco");
    expect(prompt).toContain("Better Me");
  });

  it("explica el criterio de reflexión y el default conservador", () => {
    const prompt = buildEnrichPrompt("x", [], []);
    expect(prompt).toContain("sigue siendo cierto mañana");
    expect(prompt).toContain("Ante la duda");
  });
});

describe("parseEnrichResult", () => {
  it("parsea una respuesta bien formada", () => {
    const out = parseEnrichResult(
      JSON.stringify({
        titulo: "Miedo a la confrontación",
        animo: "😤 Tensionado",
        intensidad: 4,
        topics: ["Terapia"],
        bigTheme: "Better Me",
        reflexion: { titulo: "T", situacion: "S" },
      }),
    );
    expect(out).toEqual({
      titulo: "Miedo a la confrontación",
      animo: "😤 Tensionado",
      intensidad: 4,
      topics: ["Terapia"],
      bigTheme: "Better Me",
      reflexion: { titulo: "T", situacion: "S" },
    });
  });

  it("tolera que el modelo envuelva el JSON en un fence", () => {
    const out = parseEnrichResult(
      '```json\n{"titulo":"T","animo":"🙂 Bien","intensidad":2,"topics":[],"bigTheme":null,"reflexion":null}\n```',
    );
    expect(out?.titulo).toBe("T");
  });

  it("devuelve null si no es JSON", () => {
    expect(parseEnrichResult("no puedo hacer eso")).toBeNull();
  });

  it("cae a Neutro si el ánimo no está en la lista", () => {
    const out = parseEnrichResult(
      '{"titulo":"T","animo":"eufórico","intensidad":3,"topics":[],"bigTheme":null,"reflexion":null}',
    );
    expect(out?.animo).toBe("😐 Neutro");
  });

  it("recorta la intensidad al rango 1-5", () => {
    expect(
      parseEnrichResult(
        '{"titulo":"T","animo":"😐 Neutro","intensidad":9,"topics":[],"bigTheme":null,"reflexion":null}',
      )?.intensidad,
    ).toBe(5);
    expect(
      parseEnrichResult(
        '{"titulo":"T","animo":"😐 Neutro","intensidad":0,"topics":[],"bigTheme":null,"reflexion":null}',
      )?.intensidad,
    ).toBe(1);
  });

  it("devuelve null si falta el título", () => {
    expect(
      parseEnrichResult(
        '{"animo":"😐 Neutro","intensidad":3,"topics":[],"bigTheme":null,"reflexion":null}',
      ),
    ).toBeNull();
  });

  it("descarta una reflexión sin título", () => {
    const out = parseEnrichResult(
      '{"titulo":"T","animo":"😐 Neutro","intensidad":3,"topics":[],"bigTheme":null,"reflexion":{"titulo":"","situacion":"S"}}',
    );
    expect(out?.reflexion).toBeNull();
  });

  it("ignora topics que no son strings", () => {
    const out = parseEnrichResult(
      '{"titulo":"T","animo":"😐 Neutro","intensidad":3,"topics":["Terapia",5,null],"bigTheme":null,"reflexion":null}',
    );
    expect(out?.topics).toEqual(["Terapia"]);
  });
});
