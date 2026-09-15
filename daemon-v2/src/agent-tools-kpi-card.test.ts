import { describe, expect, it, vi } from "vitest";

vi.mock("./proactive/kpi-card-daily.js", () => ({
  checkKpiCardDaily: vi.fn(async () => false),
}));

import { buildSdkTools } from "./agent-tools.js";

describe("generarKpiCardYape", () => {
  it("no reporta sent cuando la tarjeta falló", async () => {
    vi.stubEnv("NOTION_TOKEN", "ntn");
    const kv = {} as never;
    const tool = buildSdkTools({
      botToken: "tok",
      getCurrentChatId: () => 123,
      kv,
      cookieJarKv: kv,
      getOptions: () => ({}),
    }).find((candidate) => candidate.name === "generarKpiCardYape")!;

    const result = await tool.handler({ fechas: ["2026-09-14"] } as never, {} as never);
    const content = result.content[0]!;
    expect(content.type).toBe("text");
    if (content.type !== "text") throw new Error("resultado sin texto");
    const payload = JSON.parse(content.text);

    expect(payload.status).toBe("failed");
    expect(payload.fechas).toEqual(["2026-09-14"]);
  });
});
