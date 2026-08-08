import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendBacklogItem, markBacklogDone, markBacklogDiscarded, restoreBacklogSnapshot } from "./backlog-write.js";

const DIR = join(tmpdir(), "jano-test-backlog-write");
const FILE = join(DIR, "BACKLOG.md");

const BASE = `# Backlog — Test

## Pendientes

### Sección vieja
- [ ] Ítem viejo
- [ ] Otro ítem viejo

## Completados
- [x] Algo hecho
`;

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, BASE);
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe("appendBacklogItem", () => {
  it("crea la sección del día justo debajo de ## Pendientes", () => {
    appendBacklogItem(FILE, "Idea nueva", "2026-07-28");
    const out = readFileSync(FILE, "utf8");
    expect(out).toContain("### Surgió en sesión 2026-07-28");
    expect(out).toContain("- [ ] **Idea nueva**");
    const iPend = out.indexOf("## Pendientes");
    const iNueva = out.indexOf("### Surgió en sesión 2026-07-28");
    const iVieja = out.indexOf("### Sección vieja");
    expect(iPend).toBeLessThan(iNueva);
    expect(iNueva).toBeLessThan(iVieja);
  });

  it("reusa la sección del día si ya existe", () => {
    appendBacklogItem(FILE, "Primera", "2026-07-28");
    appendBacklogItem(FILE, "Segunda", "2026-07-28");
    const out = readFileSync(FILE, "utf8");
    expect(out.match(/### Surgió en sesión 2026-07-28/g)).toHaveLength(1);
    expect(out.indexOf("Primera")).toBeLessThan(out.indexOf("Segunda"));
  });

  it("no toca el contenido preexistente", () => {
    appendBacklogItem(FILE, "Idea nueva", "2026-07-28");
    const out = readFileSync(FILE, "utf8");
    expect(out).toContain("- [ ] Ítem viejo");
    expect(out).toContain("- [x] Algo hecho");
    expect(out).toContain("### Sección vieja");
  });

  it("agrega al final si no hay ## Pendientes", () => {
    writeFileSync(FILE, "# Solo un título\n");
    appendBacklogItem(FILE, "Idea suelta", "2026-07-28");
    const out = readFileSync(FILE, "utf8");
    expect(out).toContain("# Solo un título");
    expect(out.trimEnd().endsWith("- [ ] **Idea suelta**")).toBe(true);
  });
});

describe("markBacklogDone", () => {
  it("tilda el ítem cuando hay exactamente una coincidencia", () => {
    const res = markBacklogDone(FILE, "Otro ítem viejo");
    expect(res.ok).toBe(true);
    const out = readFileSync(FILE, "utf8");
    expect(out).toContain("- [x] Otro ítem viejo");
    expect(out).toContain("- [ ] Ítem viejo");
  });

  it("falla explícito si no encuentra nada", () => {
    const res = markBacklogDone(FILE, "no existe esto");
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(readFileSync(FILE, "utf8")).toBe(BASE);
  });

  it("falla explícito y lista candidatos si hay más de una coincidencia", () => {
    const res = markBacklogDone(FILE, "ítem viejo");
    expect(res.ok).toBe(false);
    if (res.ok === false && res.reason === "ambiguous") {
      expect(res.candidates).toHaveLength(2);
    } else {
      throw new Error("esperaba ambiguous");
    }
    expect(readFileSync(FILE, "utf8")).toBe(BASE);
  });

  it("no tilda un ítem ya tildado", () => {
    const res = markBacklogDone(FILE, "Algo hecho");
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("markBacklogDiscarded", () => {
  it("tacha el texto y anota el motivo, con [x] en vez de [ ]", () => {
    const res = markBacklogDiscarded(FILE, "Otro ítem viejo", "2026-08-08");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.line).toBe("Otro ítem viejo");
    const out = readFileSync(FILE, "utf8");
    expect(out).toContain("- [x] ~~Otro ítem viejo~~ — ❌ descartado 2026-08-08");
    expect(out).toContain("- [ ] Ítem viejo");
  });

  it("el resultado devuelve el texto LIMPIO, no el tachado, para mostrarlo en la tarjeta", () => {
    const res = markBacklogDiscarded(FILE, "Otro ítem viejo", "2026-08-08");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.line).not.toContain("~~");
      expect(res.line).not.toContain("descartado");
    }
  });

  it("falla explícito si no encuentra nada, mismo comportamiento que markBacklogDone", () => {
    const res = markBacklogDiscarded(FILE, "no existe esto", "2026-08-08");
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(readFileSync(FILE, "utf8")).toBe(BASE);
  });

  it("falla explícito con ambigüedad", () => {
    const res = markBacklogDiscarded(FILE, "ítem viejo", "2026-08-08");
    expect(res.ok).toBe(false);
    if (!res.ok && res.reason === "ambiguous") {
      expect(res.candidates).toHaveLength(2);
    } else {
      throw new Error("esperaba ambiguous");
    }
  });
});

describe("restoreBacklogSnapshot", () => {
  it("reescribe el archivo entero con el contenido dado", () => {
    markBacklogDone(FILE, "Otro ítem viejo");
    expect(readFileSync(FILE, "utf8")).not.toBe(BASE);

    restoreBacklogSnapshot(FILE, BASE);

    expect(readFileSync(FILE, "utf8")).toBe(BASE);
  });
});
