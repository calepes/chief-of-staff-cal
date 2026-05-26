import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { startup } from "@anthropic-ai/claude-agent-sdk";
import cron from "node-cron";
import type { CfKv } from "../cf-kv.js";
import { runAgent } from "../agent.js";
import {
  getNextSection,
  FOCO_PAGE_ID,
  FOCO_KPIS_VIEW_URL,
  FOCO_TAREAS_VIEW_URL,
  readFocoProgress,
  type FocoSection,
} from "../tools/foco-cal.js";
import {
  queryMeetingsByDate,
  formatFechaEs,
  type MeetingNote,
} from "../tools/meeting-notes.js";

export interface FocoCheckinOpts {
  kv: CfKv;
  botToken: string;
  chatId: number;
  options: Options;
  setCurrentChatId: (id: number) => void;
}

type Slot = "am" | "md" | "pm";

const SLOT_TONE: Record<Slot, string> = {
  am: "Mañana — pregunta qué va a mover Cal hoy",
  md: "Mediodía — pregunta qué logró esta mañana y qué queda para la tarde",
  pm: "Cierre — pregunta qué avanzó hoy y qué queda para mañana",
};

const SLOT_GREETING: Record<Slot, string> = {
  am: "☀️ Buenos días, Cal.",
  md: "🕐 Mitad del día.",
  pm: "🌆 Cierre del día.",
};

async function runFocoCheckin(opts: FocoCheckinOpts, slot: Slot): Promise<void> {
  const { kv, chatId, options, setCurrentChatId } = opts;

  // Deduplication — evita doble envío si el daemon se reinicia en el mismo slot
  const today = new Date().toISOString().slice(0, 10);
  const dedupKey = `foco_checkin_sent:${today}:${slot}`;
  const alreadySent = await kv.get<boolean>(dedupKey);
  if (alreadySent) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "foco_checkin_skip_dedup", slot }));
    return;
  }

  // Avanzar sección
  const { section } = await getNextSection(kv);

  // Leer progreso reciente para contexto (últimos 14 días)
  const recentProgress = readFocoProgress(14);
  const recentItems = recentProgress
    .slice(-10)
    .map((e) => `${e.date} [${e.section}] ${e.itemText}`)
    .join("\n");

  // Para el slot pm, consultar meetings de hoy
  let todayMeetings: MeetingNote[] = [];
  if (slot === "pm") {
    const notionToken = process.env.NOTION_TOKEN;
    if (notionToken) {
      try {
        const all = await queryMeetingsByDate({ from: today, to: today, notionToken });
        todayMeetings = all.slice(0, 5);
      } catch (err) {
        console.log(JSON.stringify({ ts: Date.now(), msg: "foco_checkin_meetings_error", err: String(err) }));
      }
    }
  }

  // Set currentChatId para que buildApprovalFlow sepa a quién enviar
  setCurrentChatId(chatId);

  let warm;
  try {
    warm = await startup({ options });
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "foco_checkin_startup_error", slot, err: String(err) }));
    return;
  }

  const prompt = buildPrompt(section, slot, recentItems, todayMeetings);

  try {
    await runAgent(prompt, { warm, history: [] });
    await kv.set(dedupKey, true, 25 * 3600);
    console.log(JSON.stringify({ ts: Date.now(), msg: "foco_checkin_sent", slot, section, meetingCount: todayMeetings.length }));
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "foco_checkin_agent_error", slot, section, err: String(err) }));
  }
}

function buildPrompt(
  section: FocoSection,
  slot: Slot,
  recentItems: string,
  todayMeetings: MeetingNote[] = [],
): string {
  const greeting = SLOT_GREETING[slot];
  const tone = SLOT_TONE[slot];
  const isKpis = section === "KPIs";
  const isTareas = section === "Tareas";

  const notionStep = isKpis
    ? `Llama mcp__claude_ai_Notion__notion-query-database-view con view_url="${FOCO_KPIS_VIEW_URL}" y page_size=5 para obtener los últimos KPIs de Yape Bolivia (Afiliaciones, DAU, TRX con variaciones vs ayer y semana anterior).`
    : isTareas
    ? `Llama mcp__claude_ai_Notion__notion-query-database-view con view_url="${FOCO_TAREAS_VIEW_URL}" para obtener las tareas de Cal esta semana.`
    : `Llama mcp__claude_ai_Notion__notion-fetch con id="${FOCO_PAGE_ID}" para leer el Foco CAL. Extrae los checkboxes pendientes (no marcados) de la sección "${section}".`;

  const kpiContext = isKpis
    ? `\nEl title del approval flow debe incluir los números reales de KPIs (ej: "KPIs · Afil: 4.2K ↑3% · DAU: 1.05M ↓1%").`
    : "";

  // Bloque de meetings para el slot pm
  const meetingsBlock =
    slot === "pm" && todayMeetings.length > 0
      ? buildMeetingsBlock(todayMeetings)
      : "";

  return `Eres Jano, CoS digital de Cal. Formato: Telegram HTML. Español neutro. Sin acks genéricos.

Contexto: check-in proactivo. Tono: ${tone}. Sección de hoy: ${section}.

Progreso reciente de Cal (últimos 14 días):
${recentItems || "(sin registros recientes)"}

${meetingsBlock}Tu tarea en ESTE turno (sin desviarte):
${meetingsBlock ? "0. PRIMERO procesa el bloque de meetings (ver arriba). DESPUÉS el check-in de Foco.\n" : ""}1. ${notionStep}
2. Con los datos obtenidos, filtra los items que ya aparecen en el progreso reciente (arriba).
3. Construye el check-in con mcp__cos-tools__buildApprovalFlow:
   - title: "${greeting} Foco CAL · ${section}"${kpiContext}
   - items: hasta 6 items pendientes. Campo id = texto del item (o URL de la tarea para Tareas DB).
   - confirmVerb: "✅ Hecho"
   - rejectVerb: "⏭ Saltar"
4. Antes del approval flow, envía 1 frase corta con el tono del slot. Solo 1 frase, sin párrafos.

Mapping al recibir callbacks jano-wiz-ok:
- stepApprovalWizard({ action: "ok" }) → recibe item.id → preguntar nota opcional → logFocoProgress({ itemText: item.label, section: "${section}", note? })`;
}

function buildMeetingsBlock(meetings: MeetingNote[]): string {
  const lines = meetings.map((m) => {
    const flag = m.hasFocoCal ? " ✦" : "";
    const dateStr = formatFechaEs(m.fecha);
    return `  - ${m.title}${flag} (${dateStr}) [id: ${m.id}]`;
  });

  return `
## Meetings de hoy (${meetings.length}):
${lines.join("\n")}

INSTRUCCIONES para meetings — ejecutar ANTES del check-in de Foco:
1. Llama mcp__cos-tools__showMeetingCards con el array meetings de abajo.
   Incluir en cada objeto: id, title, fecha, hasFocoCal (y resumenFocoCal si está disponible).
   Esto envía tarjetas Telegram para que Cal seleccione qué loguear.
2. Después de showMeetingCards, continúa inmediatamente con el check-in de Foco normal.
3. Los callbacks mlog/mskip de las tarjetas llegarán por separado — no los esperes aquí.

Datos de meetings para showMeetingCards:
${JSON.stringify(
  meetings.map((m) => ({
    id: m.id,
    title: m.title,
    fecha: m.fecha,
    hasFocoCal: m.hasFocoCal,
    resumenFocoCal: m.resumenFocoCal,
    resumen: m.resumen,
  })),
  null,
  2,
)}
`;
}

export function scheduleFocoCheckins(opts: FocoCheckinOpts): void {
  const schedules: Array<{ schedule: string; slot: Slot }> = [
    { schedule: "30 8 * * 1-5", slot: "am" },
    { schedule: "30 12 * * 1-5", slot: "md" },
    { schedule: "0 18 * * 1-5", slot: "pm" },
  ];

  for (const { schedule, slot } of schedules) {
    cron.schedule(
      schedule,
      () => {
        void runFocoCheckin(opts, slot);
      },
      { timezone: "America/La_Paz" },
    );
  }

  console.log(
    JSON.stringify({
      ts: Date.now(),
      msg: "foco_checkins_scheduled",
      slots: schedules.map((s) => `${s.slot}@${s.schedule}`),
    }),
  );
}
