import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const mockSpawn = vi.mocked(childProcess.spawnSync);

import { callNtn } from "./books.js";

describe("callNtn", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls ntn api with path and returns parsed JSON", () => {
    mockSpawn.mockReturnValue({
      status: 0,
      stdout: '{"id":"abc123"}',
      stderr: "",
    } as ReturnType<typeof childProcess.spawnSync>);

    const result = callNtn("v1/users/me");

    expect(mockSpawn).toHaveBeenCalledWith(
      "/opt/homebrew/bin/ntn",
      ["api", "v1/users/me"],
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(result).toEqual({ ok: true, data: { id: "abc123" } });
  });

  it("adds -X PATCH and -d body for PATCH calls", () => {
    mockSpawn.mockReturnValue({ status: 0, stdout: "{}", stderr: "" } as ReturnType<typeof childProcess.spawnSync>);

    callNtn("v1/pages/123", { method: "PATCH", body: { icon: "📖" } });

    expect(mockSpawn).toHaveBeenCalledWith(
      "/opt/homebrew/bin/ntn",
      ["api", "-X", "PATCH", "v1/pages/123", "-d", '{"icon":"📖"}'],
      expect.anything()
    );
  });

  it("returns ok: false on non-zero exit", () => {
    mockSpawn.mockReturnValue({ status: 1, stdout: "", stderr: "auth error" } as ReturnType<typeof childProcess.spawnSync>);
    const result = callNtn("v1/pages/bad");
    expect(result).toEqual({ ok: false, error: "auth error" });
  });
});
