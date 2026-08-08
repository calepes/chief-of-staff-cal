import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBacklogCallback, handleBacklogCallback } from "./backlog-callbacks.js";
import { BacklogStore } from "./backlog-store.js";
import { clearBacklogCache } from "./tools/backlog-discovery.js";
import * as backlogWrite from "./tools/backlog-write.js";
import type { CfKv } from "./cf-kv.js";

// Se mockea con la implementación REAL de default (via importOriginal) para que todos los
// tests existentes sigan escribiendo al filesystem real — solo los dos tests de W2 (abajo)
// pisan la implementación puntualmente con mockImplementationOnce para simular un fallo de
// escritura (ENOSPC/EACCES/etc.), que es mucho más limpio que intentar reproducirlo de verdad
// con permisos de archivo.
vi.mock("./tools/backlog-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools/backlog-write.js")>();
  return {
    ...actual,
    appendBacklogItem: vi.fn(actual.appendBacklogItem),
    markBacklogDone: vi.fn(actual.markBacklogDone),
  };
});

const ROOT = join(tmpdir(), "jano-test-backlog-cb");
const JANO = join(ROOT, "Personal/Agents/Jano/BACKLOG.md");

function fakeKv(): CfKv {
  const store = new Map<string, unknown>();
  return {
    async get<T>(k: string): Promise<T | null> {
      return (store.get(k) as T) ?? null;
    },
    async set(k: string, v: unknown): Promise<void> {
      store.set(k, v);
    },
    async delete(k: string): Promise<void> {
      store.delete(k);
    },
  } as unknown as CfKv;
}

/**
 * Captura los edits que el handler manda a Telegram, sin tocar la red.
 * Guarda también el keyboard: el anti-pattern #23 del skill telegram-bot-ux es justamente que
 * `editMessageText` PRESERVA el teclado viejo si `reply_markup` se omite, así que los tests
 * tienen que poder afirmar que se mandó `{inline_keyboard: []}` explícito.
 */
function fakeDeps(store: BacklogStore) {
  const edits: Array<{ text: string; keyboard?: unknown }> = [];
  const logs: Array<Record<string, unknown>> = [];
  return {
    edits,
    logs,
    deps: {
      store,
      root: ROOT,
      today: "2026-07-28",
      log: (obj: Record<string, unknown>) => {
        logs.push(obj);
      },
      editCard: async (_chatId: number, _messageId: number, text: string, keyboard?: unknown) => {
        edits.push({ text, keyboard });
      },
    },
  };
}

beforeEach(() => {
  clearBacklogCache();
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, "Personal/Agents/Jano"), { recursive: true });
  writeFileSync(JANO, "# Backlog\n\n## Pendientes\n\n### Vieja\n- [ ] Ítem viejo\n");
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("isBacklogCallback", () => {
  it("reconoce los prefijos propios y solo esos", () => {
    expect(isBacklogCallback("bklg:save:abc12345")).toBe(true);
    expect(isBacklogCallback("bklg:drop:abc12345")).toBe(true);
    expect(isBacklogCallback("j:menu")).toBe(false);
    expect(isBacklogCallback(undefined)).toBe(false);
  });
});

describe("handleBacklogCallback", () => {
  it("bklg:save escribe el ítem y confirma", async () => {
    const store = new BacklogStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea nueva", path: JANO });

    await handleBacklogCallback(deps, 1, 10, `bklg:save:${id}`);

    expect(readFileSync(JANO, "utf8")).toContain("- [ ] **Idea nueva**");
    expect(edits.at(-1)?.text).toContain("Anotado");
    expect(await store.getProposal(1, id)).toBeNull();
  });

  it("bklg:drop no escribe nada", async () => {
    const store = new BacklogStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    const before = readFileSync(JANO, "utf8");
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea nueva", path: JANO });

    await handleBacklogCallback(deps, 1, 10, `bklg:drop:${id}`);

    expect(readFileSync(JANO, "utf8")).toBe(before);
    expect(edits.at(-1)?.text).toContain("Descartado");
  });

  it("bklg:destpick cambia el destino sin escribir todavía", async () => {
    mkdirSync(join(ROOT, "Personal/Agents/Vesta"), { recursive: true });
    writeFileSync(join(ROOT, "Personal/Agents/Vesta/BACKLOG.md"), "## Pendientes\n");
    clearBacklogCache();
    const store = new BacklogStore(fakeKv());
    const { deps } = fakeDeps(store);
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea", path: JANO });

    await handleBacklogCallback(deps, 1, 10, `bklg:destpick:${id}:vesta`);

    const updated = await store.getProposal(1, id);
    expect(updated?.key).toBe("vesta");
    // realpathSync porque resolveBacklogPath resuelve symlinks (en macOS tmpdir() es
    // /var/folders/... pero el realpath es /private/var/folders/...).
    expect(updated?.path).toBe(realpathSync(join(ROOT, "Personal/Agents/Vesta/BACKLOG.md")));
    expect(readFileSync(JANO, "utf8")).not.toContain("Idea");
  });

  it("bklg:destpick con una clave que no resuelve avisa con ⚠️ y no toca la propuesta", async () => {
    const store = new BacklogStore(fakeKv());
    const { deps, edits, logs } = fakeDeps(store);
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea", path: JANO });

    await handleBacklogCallback(deps, 1, 10, `bklg:destpick:${id}:noexiste`);

    expect(edits.at(-1)?.text).toContain("⚠️");
    expect(edits.at(-1)?.text).toContain("No reconozco el backlog");
    expect(edits.at(-1)?.keyboard).toEqual({ inline_keyboard: [] });
    // La propuesta queda intacta (destino viejo), no se pisa con el nuevo key roto.
    expect((await store.getProposal(1, id))?.key).toBe("jano");
    expect(logs.some((l) => l.msg === "backlog_resolve_failed" && l.key === "noexiste")).toBe(true);
  });

  it("bklg:destother quita el teclado y lista las claves, sin escribir", async () => {
    const store = new BacklogStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    const before = readFileSync(JANO, "utf8");
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea", path: JANO });

    await handleBacklogCallback(deps, 1, 10, `bklg:destother:${id}`);

    expect(edits.at(-1)?.text).toContain("Escríbeme el nombre");
    expect(edits.at(-1)?.text).toContain("jano");
    // Teclado vacío EXPLÍCITO, no omitido — si no, Telegram deja vivos los botones anteriores.
    expect(edits.at(-1)?.keyboard).toEqual({ inline_keyboard: [] });
    expect(readFileSync(JANO, "utf8")).toBe(before);
  });

  it("todo cierre de tarjeta manda el teclado vacío explícito, nunca undefined", async () => {
    const store = new BacklogStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea", path: JANO });

    await handleBacklogCallback(deps, 1, 10, `bklg:save:${id}`);

    expect(edits.at(-1)?.keyboard).toEqual({ inline_keyboard: [] });
  });

  it("una propuesta expirada avisa en vez de romper", async () => {
    const store = new BacklogStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    await handleBacklogCallback(deps, 1, 10, "bklg:save:noexiste");
    expect(edits.at(-1)?.text).toContain("expiró");
  });

  it("bklg:save de un tildado ambiguo no escribe y explica", async () => {
    writeFileSync(JANO, "## Pendientes\n\n### V\n- [ ] Ítem viejo\n- [ ] Otro ítem viejo\n");
    const store = new BacklogStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    const id = await store.createProposal(1, { kind: "done", key: "jano", text: "ítem viejo", path: JANO });

    await handleBacklogCallback(deps, 1, 10, `bklg:save:${id}`);

    expect(readFileSync(JANO, "utf8")).not.toContain("[x]");
    expect(edits.at(-1)?.text).toContain("más de un");
  });

  it("bklg:edit no escribe nada, muestra el ítem actual y pide el texto nuevo con teclado vacío", async () => {
    const store = new BacklogStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    const before = readFileSync(JANO, "utf8");
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea con errata", path: JANO });

    await handleBacklogCallback(deps, 1, 10, `bklg:edit:${id}`);

    expect(readFileSync(JANO, "utf8")).toBe(before);
    expect(edits.at(-1)?.text).toContain("Idea con errata");
    // Teclado vacío EXPLÍCITO, no omitido — si no, Telegram deja vivos los botones anteriores.
    expect(edits.at(-1)?.keyboard).toEqual({ inline_keyboard: [] });
  });

  it("bklg:destother muestra el texto del ítem, no solo la lista de proyectos (W5)", async () => {
    const store = new BacklogStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea del destother", path: JANO });

    await handleBacklogCallback(deps, 1, 10, `bklg:destother:${id}`);

    expect(edits.at(-1)?.text).toContain("Idea del destother");
  });

  it("una acción desconocida no rompe y deja rastro en el log (W5)", async () => {
    const store = new BacklogStore(fakeKv());
    const { deps, edits, logs } = fakeDeps(store);
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea", path: JANO });

    await handleBacklogCallback(deps, 1, 10, `bklg:algoRaro:${id}`);

    expect(edits).toHaveLength(0);
    expect(logs).toContainEqual({ msg: "backlog_unknown_action", action: "algoRaro" });
  });

  it("W2 — un fallo al agregar el ítem (appendBacklogItem) edita la tarjeta con ⚠️ en vez de quedar en silencio", async () => {
    const store = new BacklogStore(fakeKv());
    const { deps, edits, logs } = fakeDeps(store);
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea nueva", path: JANO });
    vi.mocked(backlogWrite.appendBacklogItem).mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied, open '/some/absolute/path/BACKLOG.md.tmp-1'");
    });

    await handleBacklogCallback(deps, 1, 10, `bklg:save:${id}`);

    expect(edits.at(-1)?.text).toContain("⚠️");
    // No filtra el path absoluto ni el stack del error al chat.
    expect(edits.at(-1)?.text).not.toContain("/some/absolute/path");
    expect(edits.at(-1)?.text).not.toContain("EACCES");
    // La propuesta NO se limpia — reintentar (tocar ✅ de nuevo) tiene que seguir siendo posible.
    expect(await store.getProposal(1, id)).not.toBeNull();
    expect(logs.some((l) => l.msg === "backlog_write_failed")).toBe(true);
  });

  it("W2 — un fallo al tildar (markBacklogDone) edita la tarjeta con ⚠️ en vez de quedar en silencio", async () => {
    const store = new BacklogStore(fakeKv());
    const { deps, edits, logs } = fakeDeps(store);
    const id = await store.createProposal(1, { kind: "done", key: "jano", text: "ítem viejo", path: JANO });
    vi.mocked(backlogWrite.markBacklogDone).mockImplementationOnce(() => {
      throw new Error("ENOSPC: no space left on device, write");
    });

    await handleBacklogCallback(deps, 1, 10, `bklg:save:${id}`);

    expect(edits.at(-1)?.text).toContain("⚠️");
    expect(edits.at(-1)?.text).not.toContain("ENOSPC");
    expect(await store.getProposal(1, id)).not.toBeNull();
    expect(logs.some((l) => l.msg === "backlog_write_failed")).toBe(true);
  });
});
