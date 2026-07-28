import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countPending, readBacklogCompact, buildBacklogMap } from "./backlog-read.js";
import { clearBacklogCache, discoverBacklogs } from "./backlog-discovery.js";

const ROOT = join(tmpdir(), "jano-test-backlog-read");
const SAMPLE = `# Backlog — Test

## Pendientes

### Sección A
- [ ] **Primer ítem** con una descripción larguísima que se repite muchas veces ${"x".repeat(400)}
- [x] Ítem ya hecho
- [ ] Segundo ítem

### Sección B
- [ ] Tercer ítem
`;

function write(rel: string, content: string): void {
  const full = join(ROOT, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  clearBacklogCache();
  rmSync(ROOT, { recursive: true, force: true });
  write("Personal/Agents/Jano/BACKLOG.md", SAMPLE);
  write("Personal/Agents/Vesta/BACKLOG.md", "## Pendientes\n\n### S\n- [ ] Uno\n");
  write("Personal/Apps/Readwise/BACKLOG.md", "## Pendientes\n\n(nada)\n");
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("countPending", () => {
  it("cuenta solo las líneas sin tildar", () => {
    expect(countPending(join(ROOT, "Personal/Agents/Jano/BACKLOG.md"))).toBe(3);
  });

  it("devuelve 0 en un backlog sin pendientes", () => {
    expect(countPending(join(ROOT, "Personal/Apps/Readwise/BACKLOG.md"))).toBe(0);
  });
});

describe("readBacklogCompact", () => {
  it("devuelve solo pendientes, con su sección", () => {
    const c = readBacklogCompact(join(ROOT, "Personal/Agents/Jano/BACKLOG.md"), "jano", "Jano");
    expect(c.total).toBe(3);
    expect(c.items).toHaveLength(3);
    expect(c.items[0].section).toBe("Sección A");
    expect(c.items[2].section).toBe("Sección B");
    expect(c.items.some((i) => i.text.includes("Ítem ya hecho"))).toBe(false);
  });

  it("trunca los ítems largos para no disparar el persisted-output loop", () => {
    const c = readBacklogCompact(join(ROOT, "Personal/Agents/Jano/BACKLOG.md"), "jano", "Jano");
    expect(c.items[0].text.length).toBeLessThanOrEqual(203);
    expect(c.items[0].text.endsWith("…")).toBe(true);
  });

  it("la vista completa queda muy por debajo de 25 KB", () => {
    const c = readBacklogCompact(join(ROOT, "Personal/Agents/Jano/BACKLOG.md"), "jano", "Jano");
    expect(JSON.stringify(c).length).toBeLessThan(25_000);
  });
});

describe("buildBacklogMap", () => {
  it("agrupa y cuenta, incluyendo los que están en cero", () => {
    const rows = buildBacklogMap(discoverBacklogs(ROOT));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("jano")?.pending).toBe(3);
    expect(byKey.get("vesta")?.pending).toBe(1);
    expect(byKey.get("readwise")?.pending).toBe(0);
    expect(byKey.get("readwise")?.group).toBe("Apps");
  });
});
