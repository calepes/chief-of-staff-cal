import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSession, sessionIdsForDay, sessionIdsSince, pruneSessionLog } from "./session-log.js";

const DIR = join(tmpdir(), "jano-test-session-log");
const LOG = join(DIR, "sessions-log.jsonl");

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe("recordSession", () => {
  it("anota una sesión nueva", () => {
    recordSession(LOG, "abc-123", 42, Date.parse("2026-07-28T10:00:00Z"));
    const lines = readFileSync(LOG, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ sessionId: "abc-123", chatId: 42 });
  });

  it("no duplica la misma sesión llamada muchas veces", () => {
    const t = Date.parse("2026-07-28T10:00:00Z");
    recordSession(LOG, "abc-123", 42, t);
    recordSession(LOG, "abc-123", 42, t + 1000);
    recordSession(LOG, "abc-123", 42, t + 2000);
    expect(readFileSync(LOG, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("no rompe si el directorio no existe todavía", () => {
    const otro = join(DIR, "nested", "sessions-log.jsonl");
    expect(() => recordSession(otro, "x", 1, Date.now())).not.toThrow();
  });
});

describe("sessionIdsForDay", () => {
  it("devuelve solo las sesiones del día pedido", () => {
    recordSession(LOG, "de-hoy", 42, Date.parse("2026-07-28T10:00:00-04:00"));
    recordSession(LOG, "de-ayer", 42, Date.parse("2026-07-27T10:00:00-04:00"));
    expect(sessionIdsForDay(LOG, "2026-07-28")).toEqual(["de-hoy"]);
  });

  it("devuelve vacío si no hay archivo", () => {
    expect(sessionIdsForDay(join(DIR, "no-existe.jsonl"), "2026-07-28")).toEqual([]);
  });

  it("ignora líneas corruptas sin romper", () => {
    writeFileSync(LOG, `no es json\n${JSON.stringify({ sessionId: "ok", chatId: 1, startedAt: Date.parse("2026-07-28T12:00:00-04:00") })}\n`);
    expect(sessionIdsForDay(LOG, "2026-07-28")).toEqual(["ok"]);
  });
});

describe("sessionIdsSince", () => {
  const HORA = 3600 * 1000;

  it("incluye una sesión de hace 2 h y excluye una de hace 30 h", () => {
    const ahora = Date.parse("2026-07-28T22:00:00-04:00");
    recordSession(LOG, "hace-2h", 42, ahora - 2 * HORA);
    recordSession(LOG, "hace-30h", 42, ahora - 30 * HORA);
    expect(sessionIdsSince(LOG, ahora - 24 * HORA)).toEqual(["hace-2h"]);
  });

  it("una sesión de las 23:00 de ayer entra en el pase de hoy (el caso que el día calendario perdía)", () => {
    // El cron corre 22:00 La Paz. Una sesión de las 23:08 de AYER queda fechada ayer, así que el
    // pase de ayer (22:00) ya había corrido y el de hoy, por día calendario, no la miraría nunca.
    const anoche = Date.parse("2026-07-27T23:08:00-04:00");
    const pasoDeHoy = Date.parse("2026-07-28T22:00:00-04:00");
    recordSession(LOG, "nocturna", 42, anoche);

    // Confirmación del punto ciego con la selección vieja:
    expect(sessionIdsForDay(LOG, "2026-07-28")).toEqual([]);
    // Y con la ventana móvil sí entra:
    expect(sessionIdsSince(LOG, pasoDeHoy - 24 * HORA)).toEqual(["nocturna"]);
  });

  it("incluye el borde exacto (startedAt === sinceMs)", () => {
    const ahora = Date.parse("2026-07-28T22:00:00-04:00");
    recordSession(LOG, "borde", 42, ahora - 24 * HORA);
    expect(sessionIdsSince(LOG, ahora - 24 * HORA)).toEqual(["borde"]);
  });

  it("devuelve vacío si no hay archivo", () => {
    expect(sessionIdsSince(join(DIR, "no-existe.jsonl"), 0)).toEqual([]);
  });

  it("ignora líneas corruptas sin romper", () => {
    const ahora = Date.parse("2026-07-28T22:00:00-04:00");
    writeFileSync(
      LOG,
      `no es json\n${JSON.stringify({ sessionId: "ok", chatId: 1, startedAt: ahora - HORA })}\n`,
    );
    expect(sessionIdsSince(LOG, ahora - 24 * HORA)).toEqual(["ok"]);
  });
});

describe("pruneSessionLog", () => {
  it("borra los registros de más de 30 días", () => {
    const now = Date.parse("2026-07-28T10:00:00Z");
    recordSession(LOG, "viejo", 1, now - 40 * 24 * 3600 * 1000);
    recordSession(LOG, "nuevo", 1, now);
    pruneSessionLog(LOG, now);
    const ids = readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l).sessionId);
    expect(ids).toEqual(["nuevo"]);
  });
});
