import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
