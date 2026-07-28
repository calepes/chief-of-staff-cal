import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBacklogCallback, handleBacklogCallback } from "./backlog-callbacks.js";
import { BacklogStore } from "./backlog-store.js";
import { clearBacklogCache } from "./tools/backlog-discovery.js";
import type { CfKv } from "./cf-kv.js";

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
  return {
    edits,
    deps: {
      store,
      root: ROOT,
      today: "2026-07-28",
      log: () => {},
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
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea nueva" });

    await handleBacklogCallback(deps, 1, 10, `bklg:save:${id}`);

    expect(readFileSync(JANO, "utf8")).toContain("- [ ] **Idea nueva**");
    expect(edits.at(-1)?.text).toContain("Anotado");
    expect(await store.getProposal(1, id)).toBeNull();
  });

  it("bklg:drop no escribe nada", async () => {
    const store = new BacklogStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    const before = readFileSync(JANO, "utf8");
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea nueva" });

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
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea" });

    await handleBacklogCallback(deps, 1, 10, `bklg:destpick:${id}:vesta`);

    expect((await store.getProposal(1, id))?.key).toBe("vesta");
    expect(readFileSync(JANO, "utf8")).not.toContain("Idea");
  });

  it("bklg:destother quita el teclado y lista las claves, sin escribir", async () => {
    const store = new BacklogStore(fakeKv());
    const { deps, edits } = fakeDeps(store);
    const before = readFileSync(JANO, "utf8");
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea" });

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
    const id = await store.createProposal(1, { kind: "add", key: "jano", text: "Idea" });

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
    const id = await store.createProposal(1, { kind: "done", key: "jano", text: "ítem viejo" });

    await handleBacklogCallback(deps, 1, 10, `bklg:save:${id}`);

    expect(readFileSync(JANO, "utf8")).not.toContain("[x]");
    expect(edits.at(-1)?.text).toContain("más de un");
  });
});
