import { describe, expect, it } from "vitest";
import { BacklogStore } from "./backlog-store.js";
import type { CfKv } from "./cf-kv.js";

/** CfKv de mentira: un Map, suficiente para verificar claves y round-trip. */
function fakeKv(): CfKv & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async get<T>(k: string): Promise<T | null> {
      return (store.get(k) as T) ?? null;
    },
    async set(k: string, v: unknown): Promise<void> {
      store.set(k, v);
    },
    async delete(k: string): Promise<void> {
      store.delete(k);
    },
  } as unknown as CfKv & { store: Map<string, unknown> };
}

describe("BacklogStore", () => {
  it("guarda y recupera una propuesta", async () => {
    const kv = fakeKv();
    const s = new BacklogStore(kv);
    const id = await s.createProposal(42, { kind: "add", key: "jano", text: "Idea" });
    expect(await s.getProposal(42, id)).toEqual({ kind: "add", key: "jano", text: "Idea" });
  });

  it("aísla por chat", async () => {
    const kv = fakeKv();
    const s = new BacklogStore(kv);
    const id = await s.createProposal(42, { kind: "add", key: "jano", text: "Idea" });
    expect(await s.getProposal(99, id)).toBeNull();
  });

  it("usa un shortId de 8 caracteres, para que quepa el callback_data", async () => {
    const kv = fakeKv();
    const s = new BacklogStore(kv);
    const id = await s.createProposal(42, { kind: "add", key: "jano", text: "Idea" });
    expect(id).toHaveLength(8);
  });

  it("permite cambiar el destino conservando el id", async () => {
    const kv = fakeKv();
    const s = new BacklogStore(kv);
    const id = await s.createProposal(42, { kind: "add", key: "jano", text: "Idea" });
    await s.updateProposal(42, id, { kind: "add", key: "vesta", text: "Idea" });
    expect((await s.getProposal(42, id))?.key).toBe("vesta");
  });

  it("borra la propuesta", async () => {
    const kv = fakeKv();
    const s = new BacklogStore(kv);
    const id = await s.createProposal(42, { kind: "add", key: "jano", text: "Idea" });
    await s.clearProposal(42, id);
    expect(await s.getProposal(42, id)).toBeNull();
  });
});
