import { sendCronMessage } from "./rich-send.js";
import { nowInLaPaz } from "../journal-capture.js";

// DB "Metas Salud" en Notion — ver Health/CLAUDE.md y system-prompt.ts sección "## Salud".
const METAS_SALUD_DB_ID = "f929198356f14b148d205e4e6723646f";
const HEALTH_STATUS_URL = "https://health.carlos-cb4.workers.dev/status";
const HEALTH_SUMMARY_URL = "https://health.carlos-cb4.workers.dev/summary";
const HEALTH_MEASUREMENTS_URL = "https://health.carlos-cb4.workers.dev/measurements";
const TIMEOUT_MS = 8000;

export interface HealthGoalsCheckOpts {
  botToken: string;
  chatId: number;
  notionToken: string;
  healthApiKey: string;
  slot: "midday" | "daily";
  fetchFn?: typeof fetch;
}

interface GoalTarget {
  target: number | null;
  unit: string | null;
}

async function notionQuery(notionToken: string, fetchFn: typeof fetch) {
  const res = await fetchFn(`https://api.notion.com/v1/databases/${METAS_SALUD_DB_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ page_size: 20 }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`notion query ${res.status}`);
  return res.json() as Promise<{ results: Array<{ properties: Record<string, any> }> }>;
}

async function fetchGoalTargets(notionToken: string, fetchFn: typeof fetch): Promise<Map<string, GoalTarget>> {
  const data = await notionQuery(notionToken, fetchFn);
  const map = new Map<string, GoalTarget>();
  for (const page of data.results) {
    const props = page.properties;
    const title: string | undefined = props?.Meta?.title?.[0]?.plain_text;
    if (!title) continue;
    map.set(title, {
      target: props?.Target?.number ?? null,
      unit: props?.Unidad?.select?.name ?? null,
    });
  }
  return map;
}

interface HealthStatus {
  hoursSinceLastIngest: number | null;
}

async function isSyncFresh(apiKey: string, thresholdHours: number, fetchFn: typeof fetch): Promise<{ fresh: boolean; hoursSinceLastIngest: number | null }> {
  const res = await fetchFn(`${HEALTH_STATUS_URL}?key=${encodeURIComponent(apiKey)}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`health status ${res.status}`);
  const status = (await res.json()) as HealthStatus;
  const h = status.hoursSinceLastIngest;
  return { fresh: h != null && h < thresholdHours, hoursSinceLastIngest: h };
}

function todayLaPaz(): string {
  return nowInLaPaz().slice(0, 10);
}

async function stepsSoFarToday(apiKey: string, fetchFn: typeof fetch): Promise<number> {
  const date = todayLaPaz();
  const res = await fetchFn(
    `${HEALTH_MEASUREMENTS_URL}?start=${date}&end=${date}&metrics=step_count&limit=1000&key=${encodeURIComponent(apiKey)}`,
    { signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`health measurements ${res.status}`);
  const data = (await res.json()) as { data: Array<{ value: number }> };
  return data.data.reduce((sum, r) => sum + r.value, 0);
}

async function daySummary(apiKey: string, fetchFn: typeof fetch): Promise<Record<string, number>> {
  const date = todayLaPaz();
  const res = await fetchFn(`${HEALTH_SUMMARY_URL}?date=${date}&key=${encodeURIComponent(apiKey)}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`health summary ${res.status}`);
  const data = (await res.json()) as { metrics: Array<{ metric: string; total: number }> };
  const out: Record<string, number> = {};
  for (const m of data.metrics) out[m.metric] = m.total;
  return out;
}

const MISS_MARGIN = 0.85; // avisar solo si va por debajo del 85% del target esperado a esa hora

export async function checkHealthGoals(opts: HealthGoalsCheckOpts): Promise<void> {
  const { botToken, chatId, notionToken, healthApiKey, slot } = opts;
  const fetchFn = opts.fetchFn ?? fetch;
  const logMsg = slot === "midday" ? "health_goals_midday" : "health_goals_daily";

  let syncCheck: { fresh: boolean; hoursSinceLastIngest: number | null };
  try {
    // Umbral más estricto al mediodía (chequea data parcial del día) que a la noche (día ya cerrado).
    syncCheck = await isSyncFresh(healthApiKey, slot === "midday" ? 2 : 4, fetchFn);
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: `${logMsg}_status_error`, err: String(err) }));
    return; // fallo nuestro consultando status — no molestar a Cal por esto
  }

  if (!syncCheck.fresh) {
    // No duplica la alerta de scheduleHealthSyncCheck (esa ya avisa del corte en sí, con su
    // propio dedup de 24h) — este mensaje es más chico y explica por qué el check de metas
    // se salteó hoy, para que no parezca que Jano dejó de revisar sin avisar.
    const desc = syncCheck.hoursSinceLastIngest == null
      ? "no hay data registrada"
      : `la última sync fue hace ${syncCheck.hoursSinceLastIngest}h`;
    await sendCronMessage(botToken, {
      chatId,
      text: `⏸️ No puedo chequear tus metas de salud todavía — ${desc}. Abrí Health Auto Export para forzar el sync.`,
    });
    console.log(JSON.stringify({ ts: Date.now(), msg: `${logMsg}_stale_data`, hoursSinceLastIngest: syncCheck.hoursSinceLastIngest }));
    return;
  }

  let targets: Map<string, GoalTarget>;
  try {
    targets = await fetchGoalTargets(notionToken, fetchFn);
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: `${logMsg}_notion_error`, err: String(err) }));
    return;
  }

  const lines: string[] = [];

  if (slot === "midday") {
    const goal = targets.get("Pasos al mediodía");
    if (goal?.target != null) {
      try {
        const actual = await stepsSoFarToday(healthApiKey, fetchFn);
        if (actual < goal.target * MISS_MARGIN) {
          lines.push(`🚶 Vas en <b>${Math.round(actual)}</b> pasos a mediodía — meta ${goal.target}. Te faltan ${Math.round(goal.target - actual)}.`);
        }
        console.log(JSON.stringify({ ts: Date.now(), msg: logMsg, metric: "pasos_mediodia", actual: Math.round(actual), target: goal.target }));
      } catch (err) {
        console.log(JSON.stringify({ ts: Date.now(), msg: `${logMsg}_metric_error`, metric: "pasos_mediodia", err: String(err) }));
      }
    } else {
      // Sin rastro en logs si el título de la meta cambia en Notion, el check quedaría
      // corriendo en silencio para siempre sin evaluar nada — dejar constancia explícita.
      console.log(JSON.stringify({ ts: Date.now(), msg: `${logMsg}_target_missing`, goal: "Pasos al mediodía" }));
    }
  } else {
    let summary: Record<string, number>;
    try {
      summary = await daySummary(healthApiKey, fetchFn);
    } catch (err) {
      console.log(JSON.stringify({ ts: Date.now(), msg: `${logMsg}_summary_error`, err: String(err) }));
      return;
    }

    const stepsGoal = targets.get("Pasos diarios");
    const stepsActual = summary.step_count;
    if (stepsGoal?.target != null && stepsActual != null && stepsActual < stepsGoal.target * MISS_MARGIN) {
      lines.push(`🚶 Hoy cerraste con <b>${Math.round(stepsActual)}</b> pasos — meta ${stepsGoal.target}.`);
    }

    const sleepGoal = targets.get("Sueño diario");
    const sleepActual = summary.sleep_totalSleep;
    if (sleepGoal?.target != null && sleepActual != null && sleepActual < sleepGoal.target * MISS_MARGIN) {
      lines.push(`😴 Dormiste <b>${sleepActual.toFixed(1)}</b>hrs anoche — meta ${sleepGoal.target}hrs.`);
    }

    console.log(JSON.stringify({ ts: Date.now(), msg: logMsg, stepsActual, sleepActual, stepsTarget: stepsGoal?.target, sleepTarget: sleepGoal?.target }));
  }

  if (lines.length === 0) return; // vas bien — sin mensaje, mismo criterio que los reportes de KPIs

  const header = slot === "midday" ? "📊 <b>Check de mediodía</b>" : "📊 <b>Cierre del día</b>";
  await sendCronMessage(botToken, { chatId, text: `${header}\n\n${lines.join("\n")}` });
}
