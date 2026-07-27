import { describe, it, expect } from "vitest";
import { JournalStore } from "./journal-store.js";
import type { MetaProposal } from "./journal-types.js";

/** CfKv falso en memoria — registra los TTL para poder afirmar sobre ellos. */
class FakeKv {
  store = new Map<string, unknown>();
  ttls = new Map<string, number | undefined>();
  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }
  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.store.set(key, value);
    this.ttls.set(key, ttlSeconds);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function makeProposal(): MetaProposal {
  return {
    kind: "journal-meta",
    entryId: "entry-1",
    titulo: "Miedo a la confrontación",
    animo: "😤 Tensionado",
    intensidad: 4,
    topics: [{ id: "t1", name: "Terapia" }],
    topicsExcluidos: [],
    bigTheme: { id: "b1", name: "Better Me" },
    extracto: "hoy...",
    fechaHora: "2026-07-27T14:32:00-04:00",
    textoCrudo: "hoy me sentí raro",
    reflexion: null,
    messageId: 99,
  };
}

describe("JournalStore — propuestas", () => {
  it("guarda y recupera una propuesta por shortId", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    const id = await store.createProposal(1, makeProposal());
    expect(await store.getProposal(1, id)).toMatchObject({ entryId: "entry-1" });
  });

  it("guarda la propuesta con TTL de 1 hora", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    const id = await store.createProposal(1, makeProposal());
    expect(kv.ttls.get(`jano:journal:prop:1:${id}`)).toBe(3600);
  });

  it("aísla las propuestas por chat", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    const id = await store.createProposal(1, makeProposal());
    expect(await store.getProposal(2, id)).toBeNull();
  });

  it("clearProposal la borra", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    const id = await store.createProposal(1, makeProposal());
    await store.clearProposal(1, id);
    expect(await store.getProposal(1, id)).toBeNull();
  });

  it("genera shortIds distintos", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    const a = await store.createProposal(1, makeProposal());
    const b = await store.createProposal(1, makeProposal());
    expect(a).not.toBe(b);
  });
});

describe("JournalStore — undo", () => {
  it("guarda el snapshot con TTL de 10 minutos y lo recupera", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    await store.setUndo(1, "entry-1", { kind: "journal-meta", entryId: "entry-1", tituloPrevio: "hoy...", estadoPrevio: "Sin revisar" });
    expect(kv.ttls.get("jano:journal:undo:1:entry-1")).toBe(600);
    expect(await store.getUndo(1, "entry-1")).toEqual({ kind: "journal-meta", entryId: "entry-1", tituloPrevio: "hoy...", estadoPrevio: "Sin revisar" });
  });

  it("clearUndo lo borra", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    await store.setUndo(1, "entry-1", { kind: "journal-meta", entryId: "entry-1", tituloPrevio: "hoy...", estadoPrevio: "Sin revisar" });
    await store.clearUndo(1, "entry-1");
    expect(await store.getUndo(1, "entry-1")).toBeNull();
  });
});

describe("JournalStore — modo journal", () => {
  it("abre el modo con TTL de 30 min", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    await store.openMode(1, { abiertoEn: 1000, anchorMessageId: 5, origen: "Texto", guardadas: 0, pendientes: 0 });
    expect(kv.ttls.get("jano:journal-mode:1")).toBe(1800);
    expect(await store.getMode(1)).toMatchObject({ anchorMessageId: 5 });
  });

  it("devuelve null si el modo no está abierto", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    expect(await store.getMode(1)).toBeNull();
  });

  it("bumpMode incrementa contadores y refresca el TTL", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    await store.openMode(1, { abiertoEn: 1000, anchorMessageId: 5, origen: "Texto", guardadas: 0, pendientes: 0 });
    await store.bumpMode(1, { guardadas: 1, pendientes: 1 });
    const mode = await store.getMode(1);
    expect(mode).toMatchObject({ guardadas: 1, pendientes: 1, anchorMessageId: 5 });
    expect(kv.ttls.get("jano:journal-mode:1")).toBe(1800);
  });

  it("bumpMode no hace nada si el modo ya expiró", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    await store.bumpMode(1, { guardadas: 1, pendientes: 0 });
    expect(await store.getMode(1)).toBeNull();
  });

  it("closeMode borra el estado", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    await store.openMode(1, { abiertoEn: 1000, anchorMessageId: 5, origen: "Texto", guardadas: 0, pendientes: 0 });
    await store.closeMode(1);
    expect(await store.getMode(1)).toBeNull();
  });
});

describe("JournalStore — edición pendiente", () => {
  it("guarda a qué campo apunta la próxima respuesta de Cal", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    await store.setPendingEdit(1, { campo: "titulo", shortId: "ab12", messageId: 7 });
    expect(await store.getPendingEdit(1)).toEqual({ campo: "titulo", shortId: "ab12", messageId: 7 });
    expect(kv.ttls.get("jano:journal:edit:1")).toBe(600);
  });

  it("devuelve null si no hay edición pendiente", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    expect(await store.getPendingEdit(1)).toBeNull();
  });

  it("clearPendingEdit la borra", async () => {
    const kv = new FakeKv();
    const store = new JournalStore(kv as never);
    await store.setPendingEdit(1, { campo: "reflexion", shortId: "cd34", messageId: 9 });
    await store.clearPendingEdit(1);
    expect(await store.getPendingEdit(1)).toBeNull();
  });
});
