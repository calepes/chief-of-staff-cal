import { describe, expect, it, vi } from "vitest";
import { createWebhookWatchdogTick, ensureTelegramWebhook } from "./webhook-watchdog.js";

describe("ensureTelegramWebhook", () => {
  it("trata un fallo de red como sonda no disponible, no como webhook roto", async () => {
    const error = new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    const markBroken = vi.fn(async () => {});
    const events: Array<Record<string, unknown>> = [];

    await ensureTelegramWebhook({
      botToken: "token",
      expectedUrl: "https://worker.example/webhook",
      secret: "secret",
      fetchFn: vi.fn(async () => { throw error; }),
      markHealthy: vi.fn(async () => {}),
      markBroken,
      log: (event) => events.push(event),
    });

    expect(markBroken).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      msg: "webhook_network_probe_failed",
      operation: "getWebhookInfo",
      host: "api.telegram.org",
      errorCode: "ENOTFOUND",
    }));
  });

  it("marca roto solo después de confirmar que la URL diverge", async () => {
    const markBroken = vi.fn(async () => {});
    const events: Array<Record<string, unknown>> = [];
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { url: "https://user:pass@other.example/private?token=secret" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await ensureTelegramWebhook({
      botToken: "token",
      expectedUrl: "https://worker.example/webhook",
      secret: "secret",
      fetchFn,
      markHealthy: vi.fn(async () => {}),
      markBroken,
      log: (event) => events.push(event),
    });

    expect(markBroken).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      msg: "webhook_drift_detected",
      currentOrigin: "https://other.example",
    }));
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("distingue un rechazo de la API de un fallo de transporte", async () => {
    const events: Array<Record<string, unknown>> = [];

    await ensureTelegramWebhook({
      botToken: "token",
      expectedUrl: "https://worker.example/webhook",
      secret: "secret",
      fetchFn: vi.fn(async () => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 })),
      markHealthy: vi.fn(async () => {}),
      markBroken: vi.fn(async () => {}),
      log: (event) => events.push(event),
    });

    expect(events).toContainEqual(expect.objectContaining({ msg: "webhook_api_probe_failed", operation: "getWebhookInfo" }));
    expect(events).not.toContainEqual(expect.objectContaining({ msg: "webhook_network_probe_failed" }));
  });

  it("identifica los abortos por timeout", async () => {
    const events: Array<Record<string, unknown>> = [];

    await ensureTelegramWebhook({
      botToken: "token",
      expectedUrl: "https://worker.example/webhook",
      secret: "secret",
      fetchFn: vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }),
      markHealthy: vi.fn(async () => {}),
      markBroken: vi.fn(async () => {}),
      log: (event) => events.push(event),
    });

    expect(events).toContainEqual(expect.objectContaining({ errorCode: "TIMEOUT" }));
  });
});

describe("createWebhookWatchdogTick", () => {
  it("omite un tick mientras el chequeo anterior sigue activo", async () => {
    let finish!: () => void;
    const check = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }))
      .mockResolvedValue(undefined);
    const tick = createWebhookWatchdogTick(check, vi.fn());

    const first = tick();
    await tick();
    expect(check).toHaveBeenCalledTimes(1);

    finish();
    await first;
    await tick();
    expect(check).toHaveBeenCalledTimes(2);
  });
});
