import { describe, it, expect, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ startup: vi.fn() }));

import { buildGroupingPrompt, parseGroupingResult, groupEntries } from "./feedbin-report-groups.js";
import type { FeedbinEntry } from "../tools/feedbin-client.js";

function entry(id: number, title: string): FeedbinEntry {
  return { id, feed_id: 1, title, url: "u", author: null, summary: null, published: "2026-01-01" };
}

describe("buildGroupingPrompt", () => {
  it("lists each entry with its id and title", () => {
    const prompt = buildGroupingPrompt("perfil de prueba", [entry(1, "Uno"), entry(2, "Dos")]);
    expect(prompt).toContain("perfil de prueba");
    expect(prompt).toContain("1 | Uno");
    expect(prompt).toContain("2 | Dos");
  });
});

describe("parseGroupingResult", () => {
  const validIds = new Set([1, 2, 3]);

  it("parses well-formed JSON", () => {
    const out = parseGroupingResult('{"grupos":[{"tema":"Apple","ids":[1,2]},{"tema":"Otro","ids":[3]}]}', validIds);
    expect(out).toEqual([
      { label: "Apple", entryIds: [1, 2] },
      { label: "Otro", entryIds: [3] },
    ]);
  });

  it("tolerates a markdown fence", () => {
    const out = parseGroupingResult('```json\n{"grupos":[{"tema":"Apple","ids":[1]}]}\n```', validIds);
    expect(out).toEqual([{ label: "Apple", entryIds: [1] }]);
  });

  it("drops ids not present in validIds — nunca confía en un id inventado por el modelo", () => {
    const out = parseGroupingResult('{"grupos":[{"tema":"Apple","ids":[1,999]}]}', validIds);
    expect(out).toEqual([{ label: "Apple", entryIds: [1] }]);
  });

  it("drops a group that ends up empty after filtrar ids inválidos", () => {
    const out = parseGroupingResult('{"grupos":[{"tema":"Fantasma","ids":[999]},{"tema":"Real","ids":[1]}]}', validIds);
    expect(out).toEqual([{ label: "Real", entryIds: [1] }]);
  });

  it("drops a group without tema", () => {
    const out = parseGroupingResult('{"grupos":[{"ids":[1]},{"tema":"Real","ids":[2]}]}', validIds);
    expect(out).toEqual([{ label: "Real", entryIds: [2] }]);
  });

  it("returns [] on invalid JSON or missing grupos", () => {
    expect(parseGroupingResult("not json", validIds)).toEqual([]);
    expect(parseGroupingResult('{"foo":"bar"}', validIds)).toEqual([]);
  });
});

describe("groupEntries", () => {
  it("returns [] without calling the SDK when entries is empty", async () => {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const out = await groupEntries("perfil", []);
    expect(out).toEqual([]);
    expect(vi.mocked(sdk.startup)).not.toHaveBeenCalled();
  });

  it("calls Haiku and parses the result, filtering by valid ids", async () => {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(sdk.startup).mockResolvedValue({
      query: async function* () {
        yield { type: "result", subtype: "success", result: '{"grupos":[{"tema":"Apple","ids":[1]}]}' };
      },
      close: vi.fn(async () => {}),
    } as never);

    const out = await groupEntries("perfil", [entry(1, "iPhone")]);

    expect(out).toEqual([{ label: "Apple", entryIds: [1] }]);
  });
});
