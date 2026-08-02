import { describe, it, expect, vi, afterEach } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enviarFotoLocal } from "./telegram-files.js";

const testFiles: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const f of testFiles.splice(0)) {
    try {
      await unlink(f);
    } catch {
      // ya no existía
    }
  }
});

describe("enviarFotoLocal", () => {
  it("rechaza un path que no matchea ningún patrón permitido", async () => {
    const path = join(tmpdir(), "algo-random.png");
    await writeFile(path, Buffer.from("fake"));
    testFiles.push(path);

    const result = await enviarFotoLocal("tok", 123, path, "algo.png");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Path no permitido");
  });

  it("acepta un archivo kpi-card-*.png dentro de tmpdir", async () => {
    const path = join(tmpdir(), "kpi-card-2026-07-17.png");
    await writeFile(path, Buffer.from("fake-png"));
    testFiles.push(path);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const result = await enviarFotoLocal("tok", 123, path, "kpi-card.png");

    expect(result.ok).toBe(true);
  });

  it("sigue aceptando boa-wallet-*.png (no rompe el flujo de BoA existente)", async () => {
    const path = join(tmpdir(), "boa-wallet-test.png");
    await writeFile(path, Buffer.from("fake-png"));
    testFiles.push(path);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const result = await enviarFotoLocal("tok", 123, path, "boa-wallet.png");

    expect(result.ok).toBe(true);
  });
});

describe("enviarFotoLocal — disref-*.png (Referencias de Diseño)", () => {
  it("acepta un archivo disref-*.png dentro de tmpdir", async () => {
    const path = join(tmpdir(), "disref-linear-command-palette.png");
    await writeFile(path, Buffer.from("fake-png"));
    testFiles.push(path);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const result = await enviarFotoLocal("tok", 123, path, "disref.png");

    expect(result.ok).toBe(true);
  });

  it("acepta disref-*.jpg (imagen real de un post descargada, no un screenshot)", async () => {
    const path = join(tmpdir(), "disref-1785600000000.jpg");
    await writeFile(path, Buffer.from("fake-jpg"));
    testFiles.push(path);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const result = await enviarFotoLocal("tok", 123, path, "disref.jpg");

    expect(result.ok).toBe(true);
  });

  it("sigue rechazando kpi-card-*.jpg (los otros prefijos siguen siendo png-only)", async () => {
    const path = join(tmpdir(), "kpi-card-2026-07-17.jpg");
    await writeFile(path, Buffer.from("fake-jpg"));
    testFiles.push(path);

    const result = await enviarFotoLocal("tok", 123, path, "kpi-card.jpg");

    expect(result.ok).toBe(false);
  });
});
