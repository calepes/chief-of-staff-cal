import { spawnSync } from "node:child_process";

const NTN_BIN = "/opt/homebrew/bin/ntn";
export const BOOKS_DB    = "b9222a76e9404e229091b1c0e26c29dd";
export const BOOKS_DS    = "901dba51-1d00-4e3f-95b1-17ba628a0915";
export const TRACKING_DB = "70b1e190-8547-4813-b918-43ce59071d3e";

export type EstadoLibro =
  | "Goal" | "Reading" | "Read" | "Focus"
  | "Stand-By" | "Reference" | "wish list";
export type RatingLibro = "🥱" | "😶" | "😊" | "😍";

export interface BookResult {
  pageId: string;
  url: string;
  name: string;
  estado?: string;
  rating?: string;
  avanceTracking?: number;
  startDate?: string;
  isbn?: string;
}

export function callNtn(
  path: string,
  opts: { method?: "POST" | "PATCH" | "DELETE"; body?: unknown } = {}
): { ok: boolean; data?: unknown; error?: string } {
  const args = ["api"];
  if (opts.method) args.push("-X", opts.method);
  args.push(path);
  if (opts.body !== undefined) args.push("-d", JSON.stringify(opts.body));

  const result = spawnSync(NTN_BIN, args, {
    encoding: "utf8",
    timeout: 15_000,
  });

  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout).trim() };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch {
    return { ok: true, data: result.stdout.trim() };
  }
}
