import { describe, it, expect } from "vitest";
import { buildExtractPrompt, parseExtractResult } from "./task-extract.js";

describe("buildExtractPrompt", () => {
  it("incluye el asunto, la fecha de recepción y el cuerpo del mail", () => {
    const prompt = buildExtractPrompt("(Tarea) Revisar contrato", "2026-07-28", "Por favor revisar el contrato adjunto.");
    expect(prompt).toContain("(Tarea) Revisar contrato");
    expect(prompt).toContain("2026-07-28");
    expect(prompt).toContain("Por favor revisar el contrato adjunto.");
  });
});

describe("parseExtractResult", () => {
  it("parsea un JSON válido completo", () => {
    const raw = JSON.stringify({
      resumen: "Revisar el contrato con el proveedor X.",
      accionRequerida: "Leer el contrato y responder con comentarios.",
      contextoRelevante: "Lo pide Legal antes del viernes.",
      deadline: "2026-08-01",
      fecha: "2026-07-30",
      sinAccionClara: false,
    });
    expect(parseExtractResult(raw)).toEqual({
      resumen: "Revisar el contrato con el proveedor X.",
      accionRequerida: "Leer el contrato y responder con comentarios.",
      contextoRelevante: "Lo pide Legal antes del viernes.",
      deadline: "2026-08-01",
      fecha: "2026-07-30",
      sinAccionClara: false,
    });
  });

  it("tolera fences de markdown alrededor del JSON", () => {
    const raw = '```json\n{"resumen":"r","accionRequerida":"a","contextoRelevante":null,"deadline":null,"fecha":null,"sinAccionClara":false}\n```';
    expect(parseExtractResult(raw)?.resumen).toBe("r");
  });

  it("devuelve null si falta resumen o accionRequerida", () => {
    expect(parseExtractResult(JSON.stringify({ accionRequerida: "a" }))).toBeNull();
    expect(parseExtractResult(JSON.stringify({ resumen: "r" }))).toBeNull();
  });

  it("devuelve null si el JSON es inválido", () => {
    expect(parseExtractResult("no es json")).toBeNull();
  });

  it("descarta fechas con formato inválido en vez de inventar una fecha parseada", () => {
    const raw = JSON.stringify({
      resumen: "r",
      accionRequerida: "a",
      contextoRelevante: null,
      deadline: "el viernes que viene",
      fecha: "30/07/2026",
      sinAccionClara: false,
    });
    const result = parseExtractResult(raw);
    expect(result?.deadline).toBeNull();
    expect(result?.fecha).toBeNull();
  });

  it("recorta resumen a 280 caracteres", () => {
    const largo = "a".repeat(400);
    const raw = JSON.stringify({ resumen: largo, accionRequerida: "a", contextoRelevante: null, deadline: null, fecha: null, sinAccionClara: false });
    expect(parseExtractResult(raw)?.resumen.length).toBe(280);
  });

  it("sinAccionClara por default es false si no viene explícito true", () => {
    const raw = JSON.stringify({ resumen: "r", accionRequerida: "a" });
    expect(parseExtractResult(raw)?.sinAccionClara).toBe(false);
  });
});
