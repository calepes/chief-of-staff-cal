import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { reflectDedupKey, runReflection, SDK_SESSIONS_DIR, type ReflectionDeps } from "./learning-reflect.js";
import { BATCH_MAX_VISIBLES } from "../learning-card.js";
import type { LearningCandidate } from "../learning-types.js";

describe("SDK_SESSIONS_DIR", () => {
  // Guard contra volver a hardcodear el path: el SDK deriva el directorio de sesiones del CWD del
  // proceso, y el daemon corre con WorkingDirectory = .../Jano/daemon-v2. Hardcodear el root del
  // repo apuntaba a las sesiones de Claude Code interactivo (transcript vacío, falla silenciosa).
  it("se deriva del cwd del proceso, no de un path fijo", () => {
    expect(SDK_SESSIONS_DIR).toBe(
      join(homedir(), ".claude", "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-")),
    );
  });

  it("NO apunta al directorio de sesiones interactivas del root del repo", () => {
    // Ese era el valor hardcodeado que rompía el pase en silencio. Solo puede volver a serlo si
    // alguien re-hardcodea el path (el daemon nunca corre con el root del repo como cwd).
    expect(SDK_SESSIONS_DIR).not.toBe(
      join(homedir(), ".claude", "projects", "-Users-calepes-Claude-Projects-Personal-Agents-Jano"),
    );
  });
});

describe("reflectDedupKey", () => {
  it("usa el día calendario en hora de La Paz, no en UTC", () => {
    // 2026-07-28T01:00:00Z == 2026-07-27T21:00:00-04:00 (La Paz) — UTC ya pasó al día
    // siguiente, hora local todavía en el día anterior. Si el código usara
    // getFullYear()/getMonth()/getDate() del sistema (o UTC), este caso lo delataría.
    expect(reflectDedupKey(new Date("2026-07-28T01:00:00.000Z"))).toBe("jano:learning:reflect:2026-07-27");
  });

  it("dos corridas del mismo día comparten clave", () => {
    expect(reflectDedupKey(new Date("2026-07-27T23:00:00.000Z"))).toBe(
      reflectDedupKey(new Date("2026-07-27T23:59:00.000Z")),
    );
  });
});

const CAND: LearningCandidate = { tag: "pref", text: "Cal prefiere respuestas cortas", evidencia: "«sé breve»" };

/** Ocho candidatos sin parecido entre sí, para que dedupeCandidates no los colapse. */
const OCHO_DISTINTOS: LearningCandidate[] = [
  { tag: "pref", text: "Cal quiere el total antes del desglose", evidencia: "«primero el total»" },
  { tag: "err", text: "notionApi: el body va como objeto, no como string", evidencia: "«invalid_json»" },
  { tag: "hecho", text: "El colegio de las hijas cierra la última semana de julio", evidencia: "«cierran el 25»" },
  { tag: "flujo", text: "Pide la tarjeta de KPIs apenas llega el mail de BCP", evidencia: "«mandame la card»" },
  { tag: "pref", text: "Las cifras de dinero van con separador de miles", evidencia: "«ponelo con puntos»" },
  { tag: "hecho", text: "Noe viaja a Lima el primer fin de semana de cada mes", evidencia: "«se va a Lima»" },
  { tag: "err", text: "yt-dlp necesita cookies de Safari para bajar videos", evidencia: "«sign in to confirm»" },
  { tag: "flujo", text: "Arranca el día con un briefing de reuniones y vuelos", evidencia: "«qué tengo hoy»" },
];

function makeDeps(overrides: Partial<ReflectionDeps> = {}): ReflectionDeps {
  return {
    sessionIds: ["s1"],
    transcript: "CAL: hola\nJANO: hola",
    existentes: [],
    extract: vi.fn(async () => []),
    createBatch: vi.fn(async () => "batch1"),
    send: vi.fn(async () => {}),
    log: vi.fn(),
    ...overrides,
  };
}

describe("runReflection", () => {
  it("sin sesiones no llama al extractor ni manda nada", async () => {
    const deps = makeDeps({ sessionIds: [] });
    await runReflection(deps, "2026-07-28");

    expect(deps.extract).not.toHaveBeenCalled();
    expect(deps.createBatch).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith({ msg: "learning_reflect_no_sessions", fecha: "2026-07-28" });
  });

  it("el extractor devuelve [] y no manda nada", async () => {
    const deps = makeDeps({ extract: vi.fn(async () => []) });
    await runReflection(deps, "2026-07-28");

    expect(deps.extract).toHaveBeenCalledTimes(1);
    expect(deps.createBatch).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith({ msg: "learning_reflect_empty", fecha: "2026-07-28", raw: 0 });
  });

  it("con candidatos crea el batch y manda la tarjeta con 'Reflexión del día'", async () => {
    const deps = makeDeps({ extract: vi.fn(async () => [CAND]) });
    await runReflection(deps, "2026-07-28");

    expect(deps.createBatch).toHaveBeenCalledWith([CAND], 0);
    expect(deps.send).toHaveBeenCalledTimes(1);
    const card = (deps.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(card.text).toContain("Reflexión del día");
  });

  it("candidatos que duplican un learning existente se filtran y no se manda nada", async () => {
    const existentes = [{ date: "2026-07-01", tag: "pref" as const, text: "Cal prefiere respuestas cortas" }];
    const deps = makeDeps({
      existentes,
      extract: vi.fn(async () => [{ ...CAND, text: "Cal prefiere respuestas cortas y directas" }]),
    });
    await runReflection(deps, "2026-07-28");

    expect(deps.createBatch).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith({ msg: "learning_reflect_empty", fecha: "2026-07-28", raw: 1 });
  });

  it("recorta a BATCH_MAX_VISIBLES al CREAR el batch, no solo al renderizar", async () => {
    // Antes el recorte era puramente de render: la tarjeta mostraba 5 y decía "(y 3 más)", pero
    // el batch guardado tenía los 8 — y `✅ Guardar todos` persistía los 8, metiendo al system
    // prompt texto que Cal nunca vio.
    // Textos SIN parecido entre sí: dedupeCandidates también deduplica dentro del batch, así que
    // ocho variantes de la misma frase colapsarían a una y el test no probaría el recorte.
    const ocho: LearningCandidate[] = OCHO_DISTINTOS;
    const deps = makeDeps({ extract: vi.fn(async () => ocho) });
    await runReflection(deps, "2026-07-28");

    const guardados = (deps.createBatch as ReturnType<typeof vi.fn>).mock.calls[0][0] as LearningCandidate[];
    expect(guardados).toHaveLength(BATCH_MAX_VISIBLES);
    expect(guardados).toEqual(ocho.slice(0, BATCH_MAX_VISIBLES));

    // La tarjeta ya no puede prometer candidatos que el batch no tiene.
    const card = (deps.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(card.text).not.toContain("más)");

    expect(deps.log).toHaveBeenCalledWith({
      msg: "learning_reflect_truncated",
      fecha: "2026-07-28",
      total: 8,
      mostrados: BATCH_MAX_VISIBLES,
    });
  });

  it("no loguea truncado cuando los candidatos entran en el tope", async () => {
    const deps = makeDeps({ extract: vi.fn(async () => [CAND]) });
    await runReflection(deps, "2026-07-28");

    const msgs = (deps.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { msg: string }).msg);
    expect(msgs).not.toContain("learning_reflect_truncated");
  });

  it("si el extractor lanza, runReflection resuelve sin explotar, no manda nada, y loguea", async () => {
    const deps = makeDeps({
      extract: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    await expect(runReflection(deps, "2026-07-28")).resolves.toBeUndefined();
    expect(deps.createBatch).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith({
      msg: "learning_reflect_extract_failed",
      fecha: "2026-07-28",
      err: "Error: boom",
    });
  });
});
