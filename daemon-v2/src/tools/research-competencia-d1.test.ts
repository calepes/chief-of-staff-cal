import { describe, it, expect, vi } from "vitest";
import { queryD1 } from "./research-competencia-d1.js";

function deps(overrides: Partial<Parameters<typeof queryD1>[2]> = {}) {
  return {
    accountId: "acc123",
    databaseId: "db456",
    token: "tok789",
    fetchFn: vi.fn(),
    ...overrides,
  };
}

describe("queryD1", () => {
  it("hace POST al endpoint correcto con Authorization Bearer y el sql/params en el body", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, result: [{ success: true, results: [{ id: 1 }] }] }),
    });
    const rows = await queryD1("SELECT * FROM posts WHERE url = ?", ["https://x.com/1"], deps({ fetchFn }));
    expect(rows).toEqual([{ id: 1 }]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/acc123/d1/database/db456/query",
      {
        method: "POST",
        headers: { Authorization: "Bearer tok789", "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT * FROM posts WHERE url = ?", params: ["https://x.com/1"] }),
      },
    );
  });

  it("devuelve null si falta accountId/databaseId/token, sin llamar a fetch", async () => {
    const fetchFn = vi.fn();
    const rows = await queryD1("SELECT 1", [], { fetchFn, accountId: undefined, databaseId: "db", token: "t" });
    expect(rows).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("devuelve null si la respuesta HTTP no es ok, sin tirar", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const rows = await queryD1("SELECT 1", [], deps({ fetchFn }));
    expect(rows).toBeNull();
  });

  it("devuelve null si la respuesta trae success:false", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, errors: [{ code: 7500, message: "boom" }] }),
    });
    const rows = await queryD1("SELECT 1", [], deps({ fetchFn }));
    expect(rows).toBeNull();
  });

  it("devuelve null si fetch tira (red caída), sin propagar la excepción", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    const rows = await queryD1("SELECT 1", [], deps({ fetchFn }));
    expect(rows).toBeNull();
  });

  it("usa params vacío por default si no se pasa", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, result: [{ success: true, results: [] }] }),
    });
    await queryD1("SELECT 1", undefined as unknown as unknown[], deps({ fetchFn }));
    const body = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string);
    expect(body.params).toEqual([]);
  });

  it("devuelve null si la respuesta trae success:true en top-level pero success:false en statement", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, result: [{ success: false }] }),
    });
    const rows = await queryD1("SELECT 1", [], deps({ fetchFn }));
    expect(rows).toBeNull();
  });
});
