import { readFileSync } from "node:fs";
import { homedir } from "node:os";

// Only allow reading persisted tool-result files from Claude Code's project cache.
// Path format: ~/.claude/projects/<proj>/<session>/tool-results/toolu_<id>.json
const ALLOWED_RE = new RegExp(
  `^${homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.claude/projects/[^/]+/[^/]+/tool-results/toolu_[A-Za-z0-9]+\\.json$`,
);

export interface PersistedReadResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export function readPersistedOutput(path: string): PersistedReadResult {
  if (!ALLOWED_RE.test(path)) {
    return { ok: false, error: "Path no permitido. Solo archivos tool-results en ~/.claude/projects." };
  }

  try {
    const raw = readFileSync(path, "utf8");
    // Persisted files are JSON arrays of content blocks: [{ type: "text", text: "..." }]
    let text: string;
    try {
      const blocks = JSON.parse(raw) as Array<{ type: string; text?: string }>;
      text = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n");
    } catch {
      text = raw;
    }

    return { ok: true, text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
