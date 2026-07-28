import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleLearningCallback, isLearningCallback, type LearningCallbackDeps } from "./learning-callbacks.js";
import { LearningStore } from "./learning-store.js";
import { BATCH_MAX_VISIBLES, type Card } from "./learning-card.js";
import type { LearningBatch, LearningCandidate } from "./learning-types.js";

/** CfKv falso en memoria, igual patrón que journal-store.test.ts. */
class FakeKv {
  store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

const CANDS: LearningCandidate[] = [
  { tag: "pref", text: "Cal quiere el total antes del desglose", evidencia: "«primero el total»" },
  { tag: "err", text: "notionApi: el body va como objeto", evidencia: "«invalid_json»" },
  { tag: "hecho", text: "El colegio cierra la última semana de julio", evidencia: "«cierran el 25»" },
];

function makeBatch(overrides: Partial<LearningBatch> = {}): LearningBatch {
  return {
    fecha: "2026-07-28",
    candidates: CANDS,
    cursor: 0,
    tokensActuales: 1000,
    guardados: 0,
    descartados: 0,
    ...overrides,
  };
}

describe("isLearningCallback", () => {
  it("reconoce el prefijo lrn:", () => {
    expect(isLearningCallback("lrn:all:b1")).toBe(true);
  });
  it("rechaza otros prefijos", () => {
    expect(isLearningCallback("j:menu")).toBe(false);
  });
  it("rechaza undefined", () => {
    expect(isLearningCallback(undefined)).toBe(false);
  });
});

describe("handleLearningCallback", () => {
  let dir: string;
  let learningsPath: string;
  let kv: FakeKv;
  let store: LearningStore;
  let edits: Array<{ messageId: number; card: Card }>;
  let logs: Array<Record<string, unknown>>;
  let deps: LearningCallbackDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "learning-callbacks-"));
    learningsPath = join(dir, "learnings.md");
    kv = new FakeKv();
    store = new LearningStore(kv as never);
    edits = [];
    logs = [];
    deps = {
      store,
      learningsPath,
      today: () => "2026-07-28",
      log: (obj) => logs.push(obj),
      editCard: async (messageId, card) => {
        edits.push({ messageId, card });
      },
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lrn:all persiste todos los candidatos y limpia el batch", async () => {
    const batchId = await store.createBatch(1, makeBatch());
    await handleLearningCallback(deps, 1, 99, `lrn:all:${batchId}`);

    expect(await store.getBatch(1, batchId)).toBeNull();
    const content = readFileSync(learningsPath, "utf8");
    expect(content).toContain("Cal quiere el total antes del desglose");
    expect(content).toContain("notionApi: el body va como objeto");
    expect(content).toContain("El colegio cierra la última semana de julio");
    expect(edits.at(-1)!.card.keyboard.inline_keyboard).toEqual([]);
  });

  it("lrn:all sobre un batch ya recortado por el cron persiste exactamente los 5 mostrados", async () => {
    // Integración con el recorte del cron (runReflection corta a BATCH_MAX_VISIBLES antes de
    // createBatch). Con 8 candidatos extraídos, el batch que llega a KV tiene 5, así que
    // `✅ Guardar todos` no puede persistir nada que la tarjeta no haya mostrado.
    const ocho: LearningCandidate[] = Array.from({ length: 8 }, (_, i) => ({
      tag: "pref" as const,
      text: `Preferencia distinta número ${i}`,
      evidencia: `«evidencia ${i}»`,
    }));
    const recortados = ocho.slice(0, BATCH_MAX_VISIBLES);
    const batchId = await store.createBatch(1, makeBatch({ candidates: recortados }));

    await handleLearningCallback(deps, 1, 99, `lrn:all:${batchId}`);

    const lineas = readFileSync(learningsPath, "utf8").trim().split("\n");
    expect(lineas).toHaveLength(BATCH_MAX_VISIBLES);
    expect(lineas.join("\n")).toContain("Preferencia distinta número 4");
    expect(lineas.join("\n")).not.toContain("Preferencia distinta número 5");
  });

  it("lrn:none no persiste nada y limpia el batch", async () => {
    const batchId = await store.createBatch(1, makeBatch());
    await handleLearningCallback(deps, 1, 99, `lrn:none:${batchId}`);

    expect(await store.getBatch(1, batchId)).toBeNull();
    expect(existsSync(learningsPath)).toBe(false);
    expect(edits.at(-1)!.card.text).toContain("No guardé");
    expect(edits.at(-1)!.card.keyboard.inline_keyboard).toEqual([]);
  });

  it("lrn:keep persiste solo el candidato del cursor y avanza", async () => {
    const batchId = await store.createBatch(1, makeBatch());
    await handleLearningCallback(deps, 1, 99, `lrn:keep:${batchId}`);

    const content = readFileSync(learningsPath, "utf8");
    expect(content).toContain("Cal quiere el total antes del desglose");
    expect(content).not.toContain("notionApi");

    const batch = await store.getBatch(1, batchId);
    expect(batch).toMatchObject({ cursor: 1, guardados: 1, descartados: 0 });
  });

  it("lrn:skip avanza sin persistir", async () => {
    const batchId = await store.createBatch(1, makeBatch());
    await handleLearningCallback(deps, 1, 99, `lrn:skip:${batchId}`);

    expect(existsSync(learningsPath)).toBe(false);
    const batch = await store.getBatch(1, batchId);
    expect(batch).toMatchObject({ cursor: 1, guardados: 0, descartados: 1 });
  });

  it("el cierre reporta los totales acumulados reales (Fix A: no solo la última acción)", async () => {
    const batchId = await store.createBatch(1, makeBatch());
    // Guarda el 1ro, guarda el 2do, salta el 3ro (último) -> cierre natural.
    await handleLearningCallback(deps, 1, 99, `lrn:keep:${batchId}`);
    await handleLearningCallback(deps, 1, 99, `lrn:keep:${batchId}`);
    await handleLearningCallback(deps, 1, 99, `lrn:skip:${batchId}`);

    // El batch se cerró solo al pasar el último candidato.
    expect(await store.getBatch(1, batchId)).toBeNull();
    const final = edits.at(-1)!.card;
    expect(final.text).toContain("Guardé 2");
    expect(final.text).toContain("descarté 1");
    expect(final.keyboard.inline_keyboard).toEqual([]);
  });

  it("Fix B: Terminar tras guardar 2 y saltar 1 reporta los totales reales, no 'no guardé ninguno'", async () => {
    // Batch con un 4to candidato para poder tocar "Terminar" (lrn:none) ANTES de que
    // el recorrido termine solo por agotar los candidatos (eso ya lo cubre el test de arriba).
    const batchId = await store.createBatch(1, makeBatch({ candidates: [...CANDS, CANDS[0]!] }));
    await handleLearningCallback(deps, 1, 99, `lrn:keep:${batchId}`); // guarda 1
    await handleLearningCallback(deps, 1, 99, `lrn:keep:${batchId}`); // guarda 2
    await handleLearningCallback(deps, 1, 99, `lrn:skip:${batchId}`); // descarta 1
    // cursor en 3 de 4 — el batch sigue vivo. Tocar "⏹️ Terminar" (lrn:none).
    await handleLearningCallback(deps, 1, 99, `lrn:none:${batchId}`);

    expect(await store.getBatch(1, batchId)).toBeNull();
    const final = edits.at(-1)!.card;
    expect(final.text).toContain("Guardé 2");
    expect(final.text).toContain("descarté 1");
    expect(final.text).not.toContain("No guardé nada");
    expect(final.keyboard.inline_keyboard).toEqual([]);
  });

  it("batch inexistente avisa que expiró, con teclado vacío explícito", async () => {
    await handleLearningCallback(deps, 1, 99, "lrn:all:nope");
    expect(edits).toHaveLength(1);
    expect(edits[0]!.card.text).toContain("expiró");
    expect(edits[0]!.card.keyboard.inline_keyboard).toEqual([]);
  });

  it("acción desconocida no rompe ni escribe, solo loguea", async () => {
    const batchId = await store.createBatch(1, makeBatch());
    await handleLearningCallback(deps, 1, 99, `lrn:bogus:${batchId}`);

    expect(edits).toHaveLength(0);
    expect(existsSync(learningsPath)).toBe(false);
    expect(await store.getBatch(1, batchId)).not.toBeNull();
    expect(logs).toContainEqual({ msg: "learning_unknown_action", action: "bogus" });
  });
});
