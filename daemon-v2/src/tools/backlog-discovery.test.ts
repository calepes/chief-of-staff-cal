import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { discoverBacklogs, deriveKey, resolveBacklogPath, clearBacklogCache } from "./backlog-discovery.js";

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
  it("desambigua 3 backlogs con la misma carpeta de proyecto, sin perder ninguno y en forma estable", () => {
    // A/Agents/Jano, B/Agents/Jano, C/Agents/Jano: mismo nombre de proyecto (Jano) Y mismo
    // nombre de carpeta padre (Agents) — solo la carpeta ABUELA (A/B/C) los distingue.
    rmSync(ROOT, { recursive: true, force: true });
    write("A/Agents/Jano/BACKLOG.md");
    write("B/Agents/Jano/BACKLOG.md");
    write("C/Agents/Jano/BACKLOG.md");
    clearBacklogCache();

    const run1 = discoverBacklogs(ROOT).map((e) => e.key).sort();
    clearBacklogCache();
    const run2 = discoverBacklogs(ROOT).map((e) => e.key).sort();

    expect(run1).toHaveLength(3);
    expect(new Set(run1).size).toBe(3);
    expect(run1).toEqual(run2);
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
  it("descubre un backlog anidado a profundidad 5-6 (ej. Pecunia/pfm-dashboard, Combustible/repo/docs)", () => {
    write("Personal/Agents/Pecunia/pfm-dashboard/BACKLOG.md"); // profundidad 5
    write("Personal/Apps/Combustible/repo/docs/BACKLOG.md"); // profundidad 6
    clearBacklogCache();

    const keys = discoverBacklogs(ROOT).map((e) => e.key);
    expect(keys).toContain("pfm-dashboard");
    expect(keys).toContain("docs");
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
