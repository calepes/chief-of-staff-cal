import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscript, buildDayTranscript } from "./learning-transcript.js";

const DIR = join(tmpdir(), "jano-test-transcript");

/** Un .jsonl del SDK: una línea por evento. */
function writeSession(id: string, events: unknown[]): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, `${id}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n"));
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe("readTranscript", () => {
  it("extrae texto de usuario y asistente", () => {
    writeSession("s1", [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "Hola Jano" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hola Cal" }] } },
    ]);
    const t = readTranscript(join(DIR, "s1.jsonl"));
    expect(t).toContain("CAL: Hola Jano");
    expect(t).toContain("JANO: Hola Cal");
  });

  it("registra los tool calls por nombre, sin el payload", () => {
    writeSession("s2", [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "notionApi", input: { body: "x".repeat(5000) } }],
        },
      },
    ]);
    const t = readTranscript(join(DIR, "s2.jsonl"));
    expect(t).toContain("TOOL notionApi");
    expect(t).not.toContain("xxxxx");
    expect(t.length).toBeLessThan(200);
  });

  it("conserva el mensaje de error de un tool fallido", () => {
    writeSession("s3", [
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", is_error: true, content: "Error parsing JSON body" }],
        },
      },
    ]);
    const t = readTranscript(join(DIR, "s3.jsonl"));
    expect(t).toContain("ERROR");
    expect(t).toContain("Error parsing JSON body");
  });

  it("omite el resultado de un tool exitoso", () => {
    writeSession("s4", [
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", is_error: false, content: "y".repeat(3000) }],
        },
      },
    ]);
    expect(readTranscript(join(DIR, "s4.jsonl"))).not.toContain("yyyy");
  });

  it("ignora líneas corruptas", () => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, "s5.jsonl"), `basura\n${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Hola" }] } })}\n`);
    expect(readTranscript(join(DIR, "s5.jsonl"))).toContain("CAL: Hola");
  });

  it("lee los mensajes cuyo content viene como string, no como array", () => {
    // Forma real verificada sobre 40 sesiones del SDK: 144 mensajes de usuario persistidos así.
    // Descartarlos dejaba el extractor ciego a lo que escribe Cal.
    writeSession("s6", [
      { type: "user", message: { role: "user", content: "Jano, prefiero el total primero" } },
      { type: "assistant", message: { role: "assistant", content: "Anotado" } },
    ]);
    const t = readTranscript(join(DIR, "s6.jsonl"));
    expect(t).toContain("CAL: Jano, prefiero el total primero");
    expect(t).toContain("JANO: Anotado");
  });

  it("ignora un content string vacío", () => {
    writeSession("s7", [{ type: "user", message: { role: "user", content: "   " } }]);
    expect(readTranscript(join(DIR, "s7.jsonl"))).toBe("");
  });

  it("devuelve vacío si el archivo no existe", () => {
    expect(readTranscript(join(DIR, "no-existe.jsonl"))).toBe("");
  });
});

describe("buildDayTranscript", () => {
  it("concatena solo las sesiones pedidas", () => {
    writeSession("mia", [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "soy del daemon" }] } },
    ]);
    writeSession("ajena", [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "soy de Claude Code" }] } },
    ]);
    const t = buildDayTranscript(DIR, ["mia"]);
    expect(t).toContain("soy del daemon");
    expect(t).not.toContain("soy de Claude Code");
  });

  it("trunca al tope para no reventar la llamada a Haiku", () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: `mensaje número ${i} con relleno` }] },
    }));
    writeSession("gorda", many);
    expect(buildDayTranscript(DIR, ["gorda"]).length).toBeLessThanOrEqual(60_000);
  });
});
