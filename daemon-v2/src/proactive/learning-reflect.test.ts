import { describe, expect, it, vi } from "vitest";
import { reflectDedupKey, runReflection, type ReflectionDeps } from "./learning-reflect.js";
import type { LearningCandidate } from "../learning-types.js";

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
