import { readFile } from "node:fs/promises";

const CACHE_PATH = `${process.env.HOME}/.claude/hooks/cache/outlook-events.txt`;
const TIMEOUT_MS = 3000;

// Formato del cache (refresh-outlook-cache.sh):
//   Outlook hoy/manana (N):
//     - [Hoy 10:00] Título (location)
//     - [Mañana 09:00] Otro título

export interface OutlookEvent {
  when: "today" | "tomorrow";
  startTime?: string;   // HH:MM
  title: string;
  location?: string;
}

export async function getOutlookEvents(when: "today" | "tomorrow" | "both" = "today"): Promise<OutlookEvent[]> {
  let raw: string;
  try {
    raw = await Promise.race([
      readFile(CACHE_PATH, "utf-8"),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("timeout reading outlook cache")), TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    throw new Error(
      `Outlook cache no disponible: ${String(err)}. Verificar cron com.claude.outlook-cache.`,
    );
  }

  const events: OutlookEvent[] = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    // - [Hoy 10:00] Título (location)
    // - [Mañana 09:00] Título
    // - [Hoy] Título sin hora
    const m = line.match(/^\s*-\s*\[(Hoy|Mañana|Manana)(?:\s+(\d{2}:\d{2}))?\]\s+(.+?)(?:\s*\(([^)]+)\))?\s*$/i);
    if (!m) continue;
    const dayLabel = m[1]!.toLowerCase();
    const evWhen: "today" | "tomorrow" = dayLabel === "hoy" ? "today" : "tomorrow";
    if (when !== "both" && evWhen !== when) continue;
    events.push({
      when: evWhen,
      startTime: m[2],
      title: m[3]!.trim(),
      location: m[4]?.trim(),
    });
  }
  return events;
}
