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
