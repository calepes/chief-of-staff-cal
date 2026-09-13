import { describe, expect, it, vi } from "vitest";
import app from "./index.js";

describe("Panini retirado", () => {
  it("ya no expone POST /panini/register", async () => {
    const response = await app.request("/panini/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codes: ["ARG-1"] }),
    }, { INBOX: { send: vi.fn() } } as never);

    expect(response.status).toBe(404);
  });
});
