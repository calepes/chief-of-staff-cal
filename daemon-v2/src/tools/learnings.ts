import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const LEARNINGS_DIR = join(homedir(), ".claude", "learnings", "cos");
const INDEX_FILE = join(LEARNINGS_DIR, "index.md");
const BATCHES_DIR = join(homedir(), ".claude", "state", "learn-batches");

// Find the file path for an ID from the index
function findFileForId(id: string): string | null {
  const content = readFileSync(INDEX_FILE, "utf-8");
  for (const line of content.split("\n")) {
    if (!line.includes(`<!-- ${id} -->`)) continue;
    const m = line.match(/→ ([^\s#]+)/);
    if (m) return join(LEARNINGS_DIR, m[1]);
  }
  return null;
}

// Update pending/valid inside the HTML comment block containing id: <id>
function patchEntryFile(filePath: string, id: string, valid: boolean): void {
  let content = readFileSync(filePath, "utf-8");
  const idPos = content.indexOf(`id: ${id}`);
  if (idPos === -1) throw new Error(`id ${id} not found in ${filePath}`);
  const blockStart = content.lastIndexOf("<!--", idPos);
  const blockEnd = content.indexOf("-->", idPos) + 3;
  if (blockStart === -1 || blockEnd < 3) throw new Error(`comment block not found for ${id}`);
  let block = content.slice(blockStart, blockEnd);
  block = block.replace("pending: true", "pending: false");
  block = block.replace("valid: null", `valid: ${valid}`);
  content = content.slice(0, blockStart) + block + content.slice(blockEnd);
  writeFileSync(filePath, content, "utf-8");
}

// Remove [pending] tag from the index line for this id
function patchIndex(id: string): void {
  let content = readFileSync(INDEX_FILE, "utf-8");
  content = content
    .split("\n")
    .map((line) =>
      line.includes(`<!-- ${id} -->`) ? line.replace(" [pending]", "") : line
    )
    .join("\n");
  writeFileSync(INDEX_FILE, content, "utf-8");
}

function processOne(id: string, valid: boolean): string {
  const filePath = findFileForId(id);
  if (!filePath) throw new Error(`${id} no encontrado en index`);
  patchEntryFile(filePath, id, valid);
  patchIndex(id);
  return id;
}

export async function manageLearning(
  action: "keep" | "drop" | "promote" | "keepall" | "dropall",
  id: string
): Promise<{ ok: boolean; processed: string[]; message: string }> {
  try {
    if (action === "keep" || action === "drop") {
      const processed = processOne(id, action === "keep");
      return { ok: true, processed: [processed], message: `${action}: ${id}` };
    }

    if (action === "promote") {
      // promote = keep + bump confirmations (future: move tier)
      const processed = processOne(id, true);
      return { ok: true, processed: [processed], message: `promote: ${id} (marcado válido)` };
    }

    if (action === "keepall" || action === "dropall") {
      const batchPath = join(BATCHES_DIR, id);
      const ids = readFileSync(batchPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean);
      const valid = action === "keepall";
      const processed: string[] = [];
      const failed: string[] = [];
      for (const entryId of ids) {
        try {
          processOne(entryId, valid);
          processed.push(entryId);
        } catch {
          failed.push(entryId);
        }
      }
      const msg = `${action}: ${processed.length}/${ids.length} procesados${failed.length ? ` (fallaron: ${failed.join(", ")})` : ""}`;
      return { ok: true, processed, message: msg };
    }

    return { ok: false, processed: [], message: `Acción desconocida: ${action}` };
  } catch (e) {
    return { ok: false, processed: [], message: `Error: ${(e as Error).message}` };
  }
}
