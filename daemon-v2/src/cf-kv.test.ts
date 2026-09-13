import { afterEach, describe, expect, it, vi } from "vitest";
import { CfKv } from "./cf-kv.js";

describe("CfKv", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("limita la duración de todas las llamadas a Cloudflare", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const kv = new CfKv({ accountId: "account", namespaceId: "namespace", apiToken: "token" });

    await kv.get("get");
    await kv.getText("text");
    await kv.set("set", { ok: true });
    await kv.delete("delete");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
