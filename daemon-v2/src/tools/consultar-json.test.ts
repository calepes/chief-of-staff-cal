import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { consultarJson } from "./consultar-json.js";

// La allowlist exige la forma real de un persisted-output del SDK:
// ~/.claude/projects/<proj>/<session>/tool-results/toolu_<id>.json
const PROJ_DIR = join(homedir(), ".claude", "projects", "jano-test-consultar-json", "sesion-test", "tool-results");
const FILE = join(PROJ_DIR, "toolu_testconsultarjson.json");

/** Escribe un persisted-output real: array de content blocks con el JSON dentro de `.text`. */
function writePersisted(payload: unknown): void {
  mkdirSync(PROJ_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify([{ type: "text", text: JSON.stringify(payload) }]));
}

beforeEach(() => {
  writePersisted({
    results: [
      { properties: { Fecha: { date: { start: "2026-07-25" } }, TRX: { number: 100 } } },
      { properties: { Fecha: { date: { start: "2026-07-26" } }, TRX: { number: 200 } } },
      { properties: { Fecha: { date: { start: "2026-08-01" } }, TRX: { number: 300 } } },
    ],
  });
});

afterEach(() => {
  rmSync(join(homedir(), ".claude", "projects", "jano-test-consultar-json"), { recursive: true, force: true });
});

describe("consultarJson", () => {
  it("rechaza un path fuera de la allowlist", async () => {
    const r = await consultarJson("/etc/passwd", ".");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Path no permitido");
  });

  it("rechaza un path que parece válido pero sale del árbol permitido", async () => {
    const r = await consultarJson(join(homedir(), ".claude/projects/x/y/tool-results/../../../../.ssh/id_ed25519"), ".");
    expect(r.ok).toBe(false);
  });

  it("rechaza `..` en los segmentos intermedios (evasión de la allowlist)", async () => {
    // Regresión de W4 (daemon-health-reviewer): los `[^/]+` del regex aceptan `..`, así que
    // este path pasaba el chequeo textual y resolvía FUERA del árbol permitido. Se cierra
    // con realpathSync ANTES de validar. Se prueba contra un archivo que existe de verdad
    // (el propio FILE, alcanzado por una ruta con `..`) — si no, el rechazo podría venir de
    // "no existe" en vez de la allowlist, y el test pasaría por el motivo equivocado.
    const evasivo = join(PROJ_DIR, "..", "tool-results", "toolu_testconsultarjson.json");
    const rOk = await consultarJson(evasivo, ".");
    expect(rOk.ok).toBe(true); // este resuelve DENTRO del árbol: debe funcionar

    const fuera = join(homedir(), ".claude", "projects", "..", "..", "tool-results", "toolu_x.json");
    const rFuera = await consultarJson(fuera, ".");
    expect(rFuera.ok).toBe(false);
  });

  it("cuenta filas sin traer el archivo entero", async () => {
    const r = await consultarJson(FILE, ".results | length");
    expect(r.ok).toBe(true);
    expect(r.text?.trim()).toBe("3");
  });

  it("extrae solo los campos pedidos", async () => {
    const r = await consultarJson(FILE, "[.results[].properties.TRX.number]");
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.text!)).toEqual([100, 200, 300]);
  });

  it("filtra por fecha", async () => {
    const r = await consultarJson(
      FILE,
      '[.results[] | select(.properties.Fecha.date.start | startswith("2026-07")) | .properties.TRX.number]',
    );
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.text!)).toEqual([100, 200]);
  });

  it("devuelve el error de jq cuando la expresión es inválida", async () => {
    const r = await consultarJson(FILE, "esto no es jq válido {{{");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("jq falló");
  });

  it("NO expone el entorno del daemon — `env` en la expresión no filtra secretos", async () => {
    // jq expone process.env vía `env`/`$ENV`. El daemon corre con NOTION_TOKEN y el bot token
    // cargados, así que consultar-json debe pasarle un entorno limpio. Si esta prueba falla,
    // una expresión jq podría volcar los secretos de Cal al contexto y de ahí a Telegram.
    process.env.JANO_TEST_SECRETO = "no-debe-verse";
    try {
      const r = await consultarJson(FILE, "env.JANO_TEST_SECRETO");
      expect(r.ok).toBe(true);
      expect(r.text).not.toContain("no-debe-verse");
      expect(r.text?.trim()).toBe("null");
    } finally {
      delete process.env.JANO_TEST_SECRETO;
    }
  });

  it("tampoco expone el entorno vía $ENV", async () => {
    process.env.JANO_TEST_SECRETO2 = "tampoco-esto";
    try {
      const r = await consultarJson(FILE, "$ENV | tostring");
      expect(r.text ?? "").not.toContain("tampoco-esto");
    } finally {
      delete process.env.JANO_TEST_SECRETO2;
    }
  });

  it("trunca una salida gigante en vez de reventar el contexto", async () => {
    writePersisted({ results: Array.from({ length: 20000 }, (_, i) => ({ n: i, relleno: "x".repeat(50) })) });
    const r = await consultarJson(FILE, ".");
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.text!.length).toBeLessThanOrEqual(20_000);
  });
});
