import { describe, it, expect, vi } from "vitest";
import { sendNotifySummary, notifyFatalError, NOTIF_CHAT_ID, wantsNoNotify } from "./research-competencia-notify.js";

describe("wantsNoNotify", () => {
  it("detecta el flag --no-notify entre los args", () => {
    expect(wantsNoNotify(["--timeframe=14", "--no-notify"])).toBe(true);
  });

  it("false si el flag no está", () => {
    expect(wantsNoNotify(["--timeframe=14"])).toBe(false);
  });
});

describe("sendNotifySummary", () => {
  it("manda el HTML al chat de notificaciones con parse_mode HTML", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    });

    const result = await sendNotifySummary("<b>hola</b>", { token: "tok123", fetchFn: fetchFn as unknown as typeof fetch });

    expect(result).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bottok123/sendMessage");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ chat_id: NOTIF_CHAT_ID, text: "<b>hola</b>", parse_mode: "HTML" });
  });

  it("devuelve ok:false sin lanzar si falta el token", async () => {
    const fetchFn = vi.fn();
    const result = await sendNotifySummary("<b>hola</b>", { token: undefined, fetchFn: fetchFn as unknown as typeof fetch });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/NOTIF_BOT_TOKEN/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("devuelve ok:false sin lanzar si el fetch rechaza (fallo de red)", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await sendNotifySummary("<b>hola</b>", { token: "tok123", fetchFn: fetchFn as unknown as typeof fetch });

    expect(result).toEqual({ ok: false, reason: "network down" });
  });

  it("devuelve ok:false sin lanzar si Telegram responde ok:false", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      statusText: "Bad Request",
      json: async () => ({ ok: false, description: "chat not found" }),
    });

    const result = await sendNotifySummary("<b>hola</b>", { token: "tok123", fetchFn: fetchFn as unknown as typeof fetch });

    expect(result).toEqual({ ok: false, reason: "chat not found" });
  });
});

describe("notifyFatalError (bloqueante 1: catch defensivo del main())", () => {
  it("manda un aviso mínimo con el mensaje del Error, escapado para HTML", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    });

    const result = await notifyFatalError(new Error("Notion <caído> & sin responder"), {
      token: "tok123",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true });
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.parse_mode).toBe("HTML");
    expect(body.text).toContain("Research de competencia falló");
    expect(body.text).toContain("Notion &lt;caído&gt; &amp; sin responder");
  });

  it("acepta un valor lanzado que no es un Error (String() de fallback)", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    await notifyFatalError("boom crudo", { token: "tok123", fetchFn: fetchFn as unknown as typeof fetch });

    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.text).toContain("boom crudo");
  });

  it("nunca lanza aunque falte el token — no depende de haber previsto el 100% de los casos", async () => {
    const result = await notifyFatalError(new Error("x"), { token: undefined });
    expect(result.ok).toBe(false);
  });
});
