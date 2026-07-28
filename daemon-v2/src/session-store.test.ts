import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// El módulo resuelve SESSIONS_PATH desde process.env.HOME al importarse, así que hay que
// apuntar HOME a un tmpdir ANTES del import y re-importar en limpio en cada test.
let tmpHome: string;
type SessionStore = typeof import("./session-store.js");

async function loadStore(): Promise<SessionStore> {
  vi.resetModules();
  return import("./session-store.js");
}

function sessionsPath(): string {
  return join(tmpHome, ".cos-agent", "sessions.json");
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "jano-sess-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("session-store", () => {
  it("devuelve undefined cuando no hay nada guardado", async () => {
    const store = await loadStore();
    expect(store.loadSessionId(94137698)).toBeUndefined();
  });

  it("guarda y recupera el sessionId de un chat", async () => {
    const store = await loadStore();
    store.saveSessionId(94137698, "abc-123");
    expect(store.loadSessionId(94137698)).toBe("abc-123");
  });

  it("aísla chats distintos", async () => {
    const store = await loadStore();
    store.saveSessionId(1, "sesion-uno");
    store.saveSessionId(2, "sesion-dos");
    expect(store.loadSessionId(1)).toBe("sesion-uno");
    expect(store.loadSessionId(2)).toBe("sesion-dos");
  });

  it("pisa el sessionId anterior del mismo chat", async () => {
    const store = await loadStore();
    store.saveSessionId(1, "vieja");
    store.saveSessionId(1, "nueva");
    expect(store.loadSessionId(1)).toBe("nueva");
  });

  it("clearSessionId olvida solo ese chat", async () => {
    const store = await loadStore();
    store.saveSessionId(1, "uno");
    store.saveSessionId(2, "dos");
    store.clearSessionId(1);
    expect(store.loadSessionId(1)).toBeUndefined();
    expect(store.loadSessionId(2)).toBe("dos");
  });

  it("ignora un sessionId vencido (TTL 12h)", async () => {
    const store = await loadStore();
    mkdirSync(join(tmpHome, ".cos-agent"), { recursive: true });
    const hace13Horas = Date.now() - 13 * 60 * 60 * 1000;
    writeFileSync(sessionsPath(), JSON.stringify({ "1": { id: "vencida", ts: hace13Horas } }));
    expect(store.loadSessionId(1)).toBeUndefined();
  });

  it("conserva un sessionId dentro del TTL", async () => {
    const store = await loadStore();
    mkdirSync(join(tmpHome, ".cos-agent"), { recursive: true });
    const hace11Horas = Date.now() - 11 * 60 * 60 * 1000;
    writeFileSync(sessionsPath(), JSON.stringify({ "1": { id: "viva", ts: hace11Horas } }));
    expect(store.loadSessionId(1)).toBe("viva");
  });

  it("purga registros vencidos de otros chats al guardar", async () => {
    const store = await loadStore();
    mkdirSync(join(tmpHome, ".cos-agent"), { recursive: true });
    writeFileSync(
      sessionsPath(),
      JSON.stringify({
        "1": { id: "vieja", ts: Date.now() - 20 * 60 * 60 * 1000 },
        "2": { id: "reciente", ts: Date.now() },
      }),
    );
    store.saveSessionId(3, "nueva");
    const data = JSON.parse(readFileSync(sessionsPath(), "utf8"));
    expect(Object.keys(data).sort()).toEqual(["2", "3"]);
  });

  it("no explota con un archivo corrupto — arranca de cero", async () => {
    const store = await loadStore();
    mkdirSync(join(tmpHome, ".cos-agent"), { recursive: true });
    writeFileSync(sessionsPath(), "{esto no es json");
    expect(store.loadSessionId(1)).toBeUndefined();
    expect(() => store.saveSessionId(1, "ok")).not.toThrow();
    expect(store.loadSessionId(1)).toBe("ok");
  });

  it("crea el directorio si no existe", async () => {
    const store = await loadStore();
    store.saveSessionId(1, "abc");
    expect(readFileSync(sessionsPath(), "utf8")).toContain("abc");
  });
});

describe("session-store — techo de turnos por sesión", () => {
  const original = process.env.JANO_MAX_SESSION_TURNS;
  afterEach(() => {
    if (original === undefined) delete process.env.JANO_MAX_SESSION_TURNS;
    else process.env.JANO_MAX_SESSION_TURNS = original;
  });

  it("cuenta turnos sobre la misma sesión", async () => {
    process.env.JANO_MAX_SESSION_TURNS = "3";
    const store = await loadStore();
    store.saveSessionId(1, "s1");
    store.saveSessionId(1, "s1");
    const data = JSON.parse(readFileSync(sessionsPath(), "utf8"));
    expect(data["1"].turns).toBe(2);
  });

  it("deja de retomar al llegar al techo", async () => {
    process.env.JANO_MAX_SESSION_TURNS = "3";
    const store = await loadStore();
    store.saveSessionId(1, "s1");
    store.saveSessionId(1, "s1");
    expect(store.loadSessionId(1)).toBe("s1"); // 2 turnos, todavía bajo el techo
    store.saveSessionId(1, "s1");
    expect(store.loadSessionId(1)).toBeUndefined(); // 3 turnos: corta
  });

  it("reinicia el contador cuando el SDK asigna una sesión nueva", async () => {
    process.env.JANO_MAX_SESSION_TURNS = "3";
    const store = await loadStore();
    store.saveSessionId(1, "s1");
    store.saveSessionId(1, "s1");
    store.saveSessionId(1, "s1");
    expect(store.loadSessionId(1)).toBeUndefined();
    store.saveSessionId(1, "s2"); // sesión nueva tras el corte
    expect(store.loadSessionId(1)).toBe("s2");
  });

  it("el techo es por chat, no global", async () => {
    process.env.JANO_MAX_SESSION_TURNS = "2";
    const store = await loadStore();
    store.saveSessionId(1, "s1");
    store.saveSessionId(1, "s1");
    store.saveSessionId(2, "s2");
    expect(store.loadSessionId(1)).toBeUndefined();
    expect(store.loadSessionId(2)).toBe("s2");
  });

  it("trata un registro viejo sin `turns` como 0 (retrocompatible)", async () => {
    const store = await loadStore();
    mkdirSync(join(tmpHome, ".cos-agent"), { recursive: true });
    writeFileSync(sessionsPath(), JSON.stringify({ "1": { id: "vieja", ts: Date.now() } }));
    expect(store.loadSessionId(1)).toBe("vieja");
  });

  it("ignora un JANO_MAX_SESSION_TURNS inválido y usa el default", async () => {
    process.env.JANO_MAX_SESSION_TURNS = "no-es-numero";
    const store = await loadStore();
    store.saveSessionId(1, "s1");
    expect(store.loadSessionId(1)).toBe("s1");
  });
});
