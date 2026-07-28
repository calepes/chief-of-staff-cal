import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { discoverBacklogs, deriveKey, resolveBacklogPath, clearBacklogCache } from "./backlog-discovery.js";

// Se mockea con la implementación REAL de default (via importOriginal) para que el resto de los
// tests de este archivo sigan usando el `find` real sobre el filesystem de prueba — solo los
// tests de "cache de fallos" (W5, abajo) pisan el mock puntualmente con mockImplementationOnce
// para simular que el find falla, sin depender de condiciones de disco reales.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const ROOT = join(tmpdir(), "jano-test-backlog-discovery");

function write(rel: string, content = "# x\n"): void {
  const full = join(ROOT, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  clearBacklogCache();
  rmSync(ROOT, { recursive: true, force: true });
  write("BACKLOG.md");
  write("Personal/Agents/Jano/BACKLOG.md");
  write("Personal/Agents/Yapito/backlog.md"); // minúscula real del disco
  write("Personal/Apps/Aeropuertos Bolivia/BACKLOG.md");
  write("Claude Code Setup/BACKLOG.md");
  // Trampas: NO deben ser descubiertos.
  write("Personal/Apps/Caltable/BACKLOGS.md");
  write("Personal/Apps/Caltable/backlog.md.bak");
  mkdirSync(join(ROOT, "node_modules", "algo"), { recursive: true });
  write("node_modules/algo/BACKLOG.md");
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("discoverBacklogs", () => {
  it("encuentra los backlogs reales y ninguna trampa", () => {
    const keys = discoverBacklogs(ROOT).map((e) => e.key).sort();
    expect(keys).toEqual([
      "aeropuertos-bolivia",
      "claude-code-setup",
      "claude-projects",
      "jano",
      "yapito",
    ]);
  });

  it("conserva el path literal del disco (backlog.md en minúscula)", () => {
    const yapito = discoverBacklogs(ROOT).find((e) => e.key === "yapito");
    expect(yapito?.path.endsWith("Yapito/backlog.md")).toBe(true);
  });

  it("agrupa por la estructura de carpetas", () => {
    const byKey = new Map(discoverBacklogs(ROOT).map((e) => [e.key, e]));
    expect(byKey.get("jano")?.group).toBe("Agentes");
    expect(byKey.get("aeropuertos-bolivia")?.group).toBe("Apps");
    expect(byKey.get("claude-projects")?.group).toBe("Raíz");
    expect(byKey.get("claude-code-setup")?.group).toBe("Raíz");
  });

  it("da labels legibles", () => {
    const byKey = new Map(discoverBacklogs(ROOT).map((e) => [e.key, e]));
    expect(byKey.get("aeropuertos-bolivia")?.label).toBe("Aeropuertos Bolivia");
    expect(byKey.get("claude-projects")?.label).toBe("General");
  });
});

describe("deriveKey", () => {
  it("normaliza espacios, mayúsculas y tildes", () => {
    expect(deriveKey("Aeropuertos Bolivia")).toBe("aeropuertos-bolivia");
    expect(deriveKey("F1 Dash")).toBe("f1-dash");
    expect(deriveKey("Migración")).toBe("migracion");
  });
});

describe("resolveBacklogPath", () => {
  it("resuelve una clave conocida", () => {
    const p = resolveBacklogPath("jano", ROOT);
    expect(p.endsWith("Personal/Agents/Jano/BACKLOG.md")).toBe(true);
  });

  it("rechaza una clave desconocida", () => {
    expect(() => resolveBacklogPath("no-existe", ROOT)).toThrow(/no reconozco/i);
  });

  it("rechaza intentos de path traversal como clave", () => {
    expect(() => resolveBacklogPath("../../etc/passwd", ROOT)).toThrow(/no reconozco/i);
  });

  it("rechaza un backlog que es symlink hacia afuera del root", () => {
    const outside = join(tmpdir(), "jano-test-backlog-outside");
    rmSync(outside, { recursive: true, force: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "BACKLOG.md"), "# fuera\n");
    mkdirSync(join(ROOT, "Personal/Agents/Fuga"), { recursive: true });
    symlinkSync(join(outside, "BACKLOG.md"), join(ROOT, "Personal/Agents/Fuga/BACKLOG.md"));
    expect(() => resolveBacklogPath("fuga", ROOT)).toThrow(/fuera del árbol/i);
    rmSync(outside, { recursive: true, force: true });
  });

  it("rechaza un symlink DENTRO del root cuyo destino real no es backlog.md (invariante 3)", () => {
    mkdirSync(join(ROOT, "Personal/Agents/Trampa"), { recursive: true });
    writeFileSync(join(ROOT, "Personal/Agents/Trampa/nota.md"), "# no es un backlog\n");
    symlinkSync(join(ROOT, "Personal/Agents/Trampa/nota.md"), join(ROOT, "Personal/Agents/Trampa/BACKLOG.md"));
    clearBacklogCache();
    expect(() => resolveBacklogPath("trampa", ROOT)).toThrow(/no apunta a un backlog\.md/i);
  });

  it("rechaza un directorio llamado BACKLOG.md (no es un archivo regular)", () => {
    mkdirSync(join(ROOT, "Personal/Agents/CarpetaTrampa/BACKLOG.md"), { recursive: true });
    clearBacklogCache();
    expect(() => resolveBacklogPath("carpetatrampa", ROOT)).toThrow(/no es un archivo/i);
  });

  it("da un mensaje entendible si el backlog desapareció del disco (symlink roto)", () => {
    mkdirSync(join(ROOT, "Personal/Agents/Roto"), { recursive: true });
    symlinkSync(join(ROOT, "Personal/Agents/Roto/no-existe.md"), join(ROOT, "Personal/Agents/Roto/BACKLOG.md"));
    clearBacklogCache();
    expect(() => resolveBacklogPath("roto", ROOT)).toThrow(/no pude leer/i);
  });
});

describe("colisión de claves", () => {
  it("dos backlogs del mismo proyecto: el de la raíz se queda con la clave pelada, el anidado se desambigua con la carpeta contenedora, ninguno se pierde, y es estable entre corridas", () => {
    // Caso real: Personal/Agents/Inversiones/BACKLOG.md (raíz del proyecto) +
    // Personal/Agents/Inversiones/docs/agente/backlog.md (anidado) — mismo proyecto
    // (Inversiones), la carpeta contenedora del anidado ("agente") lo desambigua.
    rmSync(ROOT, { recursive: true, force: true });
    write("Personal/Agents/Inversiones/BACKLOG.md");
    write("Personal/Agents/Inversiones/docs/agente/backlog.md");
    clearBacklogCache();

    const run1 = discoverBacklogs(ROOT);
    const keys1 = run1.map((e) => e.key).sort();
    clearBacklogCache();
    const run2 = discoverBacklogs(ROOT);
    const keys2 = run2.map((e) => e.key).sort();

    expect(keys1).toHaveLength(2);
    expect(new Set(keys1).size).toBe(2);
    expect(keys1).toEqual(keys2);

    const byKey = new Map(run1.map((e) => [e.key, e]));
    expect(byKey.get("inversiones")?.path.endsWith("Inversiones/BACKLOG.md")).toBe(true);
    expect(byKey.get("inversiones")?.label).toBe("Inversiones");
    const nested = byKey.get("inversiones-agente");
    expect(nested?.path.endsWith("Inversiones/docs/agente/backlog.md")).toBe(true);
    expect(nested?.label).toBe("Inversiones · agente");
  });

  it("si la carpeta contenedora TAMBIÉN colisiona, cae al sufijo numérico — sin perder ninguna entrada", () => {
    // Zeta tiene 3 backlogs: uno en la raíz del proyecto (clave pelada) y dos anidados bajo
    // carpetas distintas que ambas se llaman "docs" — ambos colisionarían en "zeta-docs".
    rmSync(ROOT, { recursive: true, force: true });
    write("Personal/Agents/Zeta/BACKLOG.md");
    write("Personal/Agents/Zeta/modulo1/docs/BACKLOG.md");
    write("Personal/Agents/Zeta/modulo2/docs/BACKLOG.md");
    clearBacklogCache();

    const run1 = discoverBacklogs(ROOT).map((e) => e.key).sort();
    clearBacklogCache();
    const run2 = discoverBacklogs(ROOT).map((e) => e.key).sort();

    expect(run1).toHaveLength(3);
    expect(new Set(run1).size).toBe(3);
    expect(run1).toEqual(run2);
    expect(run1).toEqual(["zeta", "zeta-docs", "zeta-docs-2"]);
  });

  it("descarta líneas de find rotas por saltos de línea en nombres de carpeta (path relativo)", () => {
    const weird = "Raro\nturbado";
    try {
      mkdirSync(join(ROOT, weird), { recursive: true });
    } catch {
      return; // el filesystem del entorno de test no soporta el nombre; no aplica.
    }
    writeFileSync(join(ROOT, weird, "BACKLOG.md"), "# x\n");
    clearBacklogCache();
    const entries = discoverBacklogs(ROOT);
    for (const e of entries) {
      expect(e.path === ROOT || e.path.startsWith(ROOT + sep)).toBe(true);
    }
  });
});

describe("discoverBacklogs — profundidad y poda (maxdepth 6)", () => {
  it("un backlog anidado profundo deriva la clave y el label del PROYECTO, no de la carpeta contenedora", () => {
    write("Personal/Agents/Pecunia/pfm-dashboard/BACKLOG.md"); // profundidad 5
    write("Personal/Apps/Combustible/repo/docs/BACKLOG.md"); // profundidad 6
    clearBacklogCache();

    const byKey = new Map(discoverBacklogs(ROOT).map((e) => [e.key, e]));
    expect(byKey.has("pfm-dashboard")).toBe(false);
    expect(byKey.has("docs")).toBe(false);

    expect(byKey.get("pecunia")?.label).toBe("Pecunia");
    expect(byKey.get("pecunia")?.path.endsWith("Pecunia/pfm-dashboard/BACKLOG.md")).toBe(true);

    expect(byKey.get("combustible")?.label).toBe("Combustible");
    expect(byKey.get("combustible")?.path.endsWith("Combustible/repo/docs/BACKLOG.md")).toBe(true);
  });

  it("NO descubre un backlog bajo commands/ (slash commands de Claude Code, no backlogs de proyecto)", () => {
    write("Personal/Agents/Jano/commands/backlog.md");
    clearBacklogCache();

    const paths = discoverBacklogs(ROOT).map((e) => e.path);
    expect(paths.some((p) => p.includes(`${sep}commands${sep}`))).toBe(false);
  });

  it("NO descubre un backlog bajo _archive/ (proyectos dados de baja)", () => {
    write("Personal/Apps/_archive/Pulse/BACKLOG.md");
    clearBacklogCache();

    const paths = discoverBacklogs(ROOT).map((e) => e.path);
    expect(paths.some((p) => p.includes(`${sep}_archive${sep}`))).toBe(false);
  });

  it("sigue sin descubrir nada bajo node_modules/ con el maxdepth ampliado", () => {
    mkdirSync(join(ROOT, "node_modules", "algo", "mas", "profundo"), { recursive: true });
    write("node_modules/algo/mas/profundo/BACKLOG.md");
    clearBacklogCache();

    const paths = discoverBacklogs(ROOT).map((e) => e.path);
    expect(paths.some((p) => p.includes(`${sep}node_modules${sep}`))).toBe(false);
  });
});

describe("discoverBacklogs — cache de fallos del find (W5)", () => {
  it("dos llamadas seguidas con el find fallando no ejecutan el find dos veces", () => {
    clearBacklogCache();
    const mockExec = vi.mocked(execFileSync);
    mockExec.mockClear();
    mockExec.mockImplementationOnce(() => {
      throw new Error("find: boom");
    });

    const now = 1_000_000;
    const first = discoverBacklogs(ROOT, now);
    // 1s después, bien dentro del TTL corto del fallo (45s) — no debería tocar el find de nuevo.
    const second = discoverBacklogs(ROOT, now + 1_000);

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("pasado el TTL corto del fallo, reintenta el find", () => {
    clearBacklogCache();
    const mockExec = vi.mocked(execFileSync);
    mockExec.mockClear();
    mockExec.mockImplementationOnce(() => {
      throw new Error("find: boom");
    });

    const now = 2_000_000;
    discoverBacklogs(ROOT, now);
    // 60s después, pasado el TTL corto de 45s — sí debería reintentar (y esta vez el find real
    // sobre el ROOT de prueba, ya armado en beforeEach, funciona).
    const recovered = discoverBacklogs(ROOT, now + 60_000);

    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(recovered.length).toBeGreaterThan(0);
  });
});
