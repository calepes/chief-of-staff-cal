import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendFocoProgress,
  readFocoProgress,
  sectionFromCounter,
  FOCO_SECTIONS,
  type FocoProgressEntry,
} from "./foco-cal.js";

function makeTmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "foco-test-"));
  return join(dir, "progress.json");
}

const BASE_ENTRY: Omit<FocoProgressEntry, "date"> = {
  ts: 1716307200,
  section: "CAL",
  itemText: "Delegar más",
  note: null,
};

describe("appendFocoProgress", () => {
  it("crea el archivo si no existe y agrega la entrada", () => {
    const path = makeTmpPath();
    const entry: FocoProgressEntry = { ...BASE_ENTRY, date: "2026-05-21" };
    appendFocoProgress(entry, path);
    const result = readFocoProgress(30, path);
    expect(result).toHaveLength(1);
    expect(result[0].itemText).toBe("Delegar más");
  });

  it("agrega entradas sucesivas sin sobreescribir", () => {
    const path = makeTmpPath();
    appendFocoProgress({ ...BASE_ENTRY, date: "2026-05-21" }, path);
    appendFocoProgress({ ...BASE_ENTRY, date: "2026-05-21", itemText: "Decir más No" }, path);
    const result = readFocoProgress(30, path);
    expect(result).toHaveLength(2);
  });
});

describe("readFocoProgress", () => {
  it("devuelve array vacío si el archivo no existe", () => {
    expect(readFocoProgress(30, "/tmp/nonexistent-foco-xxxx.json")).toEqual([]);
  });

  it("filtra entradas más antiguas que el límite de días", () => {
    const path = makeTmpPath();
    const today = new Date().toISOString().slice(0, 10);
    const old = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    appendFocoProgress({ ...BASE_ENTRY, date: today }, path);
    appendFocoProgress({ ...BASE_ENTRY, date: old }, path);
    const result = readFocoProgress(30, path);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe(today);
  });

  it("incluye entradas exactamente en el borde del límite", () => {
    const path = makeTmpPath();
    const borderDate = new Date(Date.now() - 30 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    appendFocoProgress({ ...BASE_ENTRY, date: borderDate }, path);
    const result = readFocoProgress(30, path);
    expect(result).toHaveLength(1);
  });
});

describe("sectionFromCounter", () => {
  it("rota cíclicamente por todas las secciones", () => {
    for (let i = 0; i < FOCO_SECTIONS.length * 2; i++) {
      expect(sectionFromCounter(i)).toBe(FOCO_SECTIONS[i % FOCO_SECTIONS.length]);
    }
  });

  it("maneja contadores negativos sin crash", () => {
    expect(() => sectionFromCounter(-1)).not.toThrow();
  });

  it("cubre las 6 secciones en 6 iteraciones consecutivas", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) seen.add(sectionFromCounter(i));
    expect(seen.size).toBe(6);
  });
});
