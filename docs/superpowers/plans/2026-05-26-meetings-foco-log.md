# Meetings → Foco Log Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrar la DB de Meetings de Notion en el flujo de Foco CAL de Jano — modo daily (6pm) y tool on-demand — con validación en dos niveles (meeting → temas).

**Architecture:** Nuevo archivo `meeting-notes.ts` con tipos, queries directas a Notion API y helpers Telegram. Tres nuevos tools registrados en `agent-tools.ts` (showMeetingCards, reviewMeetings, analyzeMeeting). El slot 6pm de `foco-check.ts` consulta meetings del día y el LLM las presenta via `showMeetingCards`. Callbacks `mlog:*` / `mskip:*` / `msel:*` disparan el flujo de temas → `buildApprovalFlow` → `logFocoProgress`.

**Tech Stack:** TypeScript, Node 22, `@anthropic-ai/claude-agent-sdk`, Notion REST API v2022-06-28, Telegram Bot API, Cloudflare KV.

---

## File Map

| Archivo | Acción | Responsabilidad |
|---------|--------|-----------------|
| `src/tools/meeting-notes.ts` | Crear | Tipos, Notion API query, parse de temas, Telegram helper |
| `src/agent-tools.ts` | Modificar | Registrar 3 nuevos tools |
| `src/agent-options.ts` | Modificar | Whitelist de los 3 nuevos tools |
| `src/proactive/foco-check.ts` | Modificar | Slot pm: query meetings + instrucciones en prompt |
| `src/system-prompt.ts` | Modificar | Instrucciones para callbacks mlog/mskip/msel |

---

## Task 1: `meeting-notes.ts` — tipos y helpers

**Files:**
- Create: `daemon-v2/src/tools/meeting-notes.ts`

- [ ] **Step 1: Crear el archivo con tipos, constantes y helpers**

```typescript
// daemon-v2/src/tools/meeting-notes.ts
import type { FocoSection } from "./foco-cal.js";

export const MEETINGS_DB_ID = "3b294b96a99347f2945d32a5399a8ce0";
const NOTION_VERSION = "2022-06-28";

export interface MeetingNote {
  id: string;
  title: string;
  fecha: string;          // YYYY-MM-DD
  resumenFocoCal: string | null;
  resumen: string | null;
  hasFocoCal: boolean;
}

export interface FocoTopic {
  text: string;
  section: FocoSection;
}

interface NotionRichText {
  plain_text: string;
}

interface NotionPage {
  id: string;
  properties: {
    "Descripción"?: { title: NotionRichText[] };
    "Fecha"?: { date: { start: string } | null };
    "Resumen Foco CAL"?: { rich_text: NotionRichText[] };
    "Resumen"?: { rich_text: NotionRichText[] };
  };
}

function extractText(richText: NotionRichText[]): string {
  return richText.map((r) => r.plain_text).join("").trim();
}

function pageToMeeting(page: NotionPage): MeetingNote {
  const title =
    extractText(page.properties["Descripción"]?.title ?? []) || "Sin título";
  const fecha =
    page.properties["Fecha"]?.date?.start?.slice(0, 10) ?? "";
  const resumenFocoCal =
    extractText(page.properties["Resumen Foco CAL"]?.rich_text ?? []) || null;
  const resumen =
    extractText(page.properties["Resumen"]?.rich_text ?? []) || null;
  return {
    id: page.id,
    title,
    fecha,
    resumenFocoCal,
    resumen,
    hasFocoCal: !!resumenFocoCal,
  };
}

export async function queryMeetingsByDate(opts: {
  from: string;
  to: string;
  notionToken: string;
}): Promise<MeetingNote[]> {
  const { from, to, notionToken } = opts;
  const body = {
    filter: {
      and: [
        { property: "Fecha", date: { on_or_after: from } },
        { property: "Fecha", date: { on_or_before: to } },
      ],
    },
    sorts: [{ property: "Fecha", direction: "ascending" as const }],
    page_size: 50,
  };

  const res = await fetch(
    `https://api.notion.com/v1/databases/${MEETINGS_DB_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    throw new Error(`Notion API error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { results?: NotionPage[] };
  return (data.results ?? []).map(pageToMeeting);
}

const SECTION_KEYWORDS: Array<[RegExp, FocoSection]> = [
  [/rufino/i, "Rufino"],
  [/christian/i, "Christian"],
  [/kpi|dau|afili|transacci|trx/i, "KPIs"],
  [/tarea|task|pendiente/i, "Tareas"],
  [/prioridad|priority|roadmap|estrategia/i, "Prioridades"],
];

export function inferSection(text: string): FocoSection {
  for (const [re, section] of SECTION_KEYWORDS) {
    if (re.test(text)) return section;
  }
  return "CAL";
}

export function parseFocoCalTopics(resumenFocoCal: string): FocoTopic[] {
  return resumenFocoCal
    .split(/\n|•|·/)
    .map((l) => l.replace(/^[-*\d.]+\s*/, "").trim())
    .filter((l) => l.length > 10)
    .slice(0, 8)
    .map((text) => ({ text, section: inferSection(text) }));
}

const DAY_ES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MONTH_ES = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];

export function formatFechaEs(isoDate: string): string {
  if (!isoDate) return "";
  const d = new Date(`${isoDate}T12:00:00Z`);
  const day = DAY_ES[d.getUTCDay()];
  const month = MONTH_ES[d.getUTCMonth()];
  return `${day} ${d.getUTCDate()} ${month}`;
}

export async function tgSend(
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: unknown,
): Promise<number> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const data = (await res.json()) as { result?: { message_id: number } };
  return data.result?.message_id ?? 0;
}
```

- [ ] **Step 2: Verificar que TypeScript compila**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm -w @cos/shared run build && npm -w @cos/daemon run build 2>&1 | tail -20
```
Expected: sin errores de tipo en `meeting-notes.ts`.

- [ ] **Step 3: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/tools/meeting-notes.ts
git commit -m "feat(meetings): add meeting-notes types and Notion/Telegram helpers"
```

---

## Task 2: Tool `showMeetingCards`

**Files:**
- Modify: `daemon-v2/src/agent-tools.ts` (importar + agregar tool)

- [ ] **Step 1: Agregar import en agent-tools.ts**

En el bloque de imports, agregar:

```typescript
import {
  queryMeetingsByDate,
  parseFocoCalTopics,
  formatFechaEs,
  tgSend,
  type MeetingNote,
  type FocoTopic,
} from "./tools/meeting-notes.js";
```

- [ ] **Step 2: Agregar tool `showMeetingCards` al array del return de `buildSdkTools`**

Insertar ANTES del tool `logFocoProgress` (línea ~404 de agent-tools.ts):

```typescript
    tool(
      "showMeetingCards",
      "Envía una tarjeta Telegram (Nivel 1) por cada reunión recibida. " +
      "Cada tarjeta muestra título + fecha y botones para loguear, analizar o saltar. " +
      "También almacena los datos de cada reunión en CF KV para uso posterior por analyzeMeeting. " +
      "Llamar cuando el prompt de check-in o un callback de selección (msel:*) requiera presentar meetings. " +
      "Máximo 5 reuniones por llamada.",
      {
        meetings: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            fecha: z.string().describe("YYYY-MM-DD"),
            hasFocoCal: z.boolean(),
            resumenFocoCal: z.string().nullable().optional(),
            resumen: z.string().nullable().optional(),
          }),
        ).max(5),
      },
      async ({ meetings }) => {
        const chatId = deps.getCurrentChatId();
        let sent = 0;

        for (const m of meetings.slice(0, 5)) {
          // Guardar datos en KV para analyzeMeeting
          await deps.kv.set(
            `meeting:${chatId}:${m.id}`,
            m as MeetingNote,
            4 * 3600,
          );

          const flag = m.hasFocoCal ? " ✦" : "";
          const dateStr = formatFechaEs(m.fecha);
          const text = `📋 <b>${m.title}</b> · ${dateStr}${flag}`;

          const keyboard = m.hasFocoCal
            ? {
                inline_keyboard: [[
                  { text: "✅ Loguear", callback_data: `mlog:${m.id}:focoCal` },
                  { text: "⏭ Saltar", callback_data: `mskip:${m.id}` },
                  { text: "🔍 Transcript", callback_data: `mlog:${m.id}:transcript` },
                ]],
              }
            : {
                inline_keyboard: [[
                  { text: "📄 Analizar", callback_data: `mlog:${m.id}:resumen` },
                  { text: "🎙 Transcript", callback_data: `mlog:${m.id}:transcript` },
                  { text: "⏭ Saltar", callback_data: `mskip:${m.id}` },
                ]],
              };

          await tgSend(deps.botToken, chatId, text, keyboard);
          sent++;
        }

        return asText({ ok: true, sent });
      },
    ),
```

- [ ] **Step 3: Compilar y verificar**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm -w @cos/daemon run build 2>&1 | tail -20
```
Expected: 0 errores.

- [ ] **Step 4: Commit**

```bash
git add daemon-v2/src/agent-tools.ts
git commit -m "feat(meetings): add showMeetingCards tool"
```

---

## Task 3: Tool `reviewMeetings` (on-demand Phase 1)

**Files:**
- Modify: `daemon-v2/src/agent-tools.ts`

- [ ] **Step 1: Agregar tool `reviewMeetings` al array del return de `buildSdkTools`**

Insertar después de `showMeetingCards`:

```typescript
    tool(
      "reviewMeetings",
      "Consulta las reuniones de un rango de fechas en la DB de Meetings de Notion y envía un " +
      "mensaje de selección (Fase 1) al chat de Cal. " +
      "Cal selecciona qué reuniones procesar con botones numerados o [Todas]. " +
      "Args: { from, to } en formato YYYY-MM-DD — el LLM parsea lenguaje natural antes de llamar. " +
      "Llamar cuando Cal pida 'revisa mis meetings de X a Y' o 'reuniones de esta semana'.",
      {
        from: z.string().describe("Fecha inicio YYYY-MM-DD"),
        to: z.string().describe("Fecha fin YYYY-MM-DD"),
      },
      async ({ from, to }) => {
        const notionToken = process.env.NOTION_TOKEN;
        if (!notionToken) return asText({ error: "NOTION_TOKEN no configurado" });

        const meetings = await queryMeetingsByDate({ from, to, notionToken });

        if (meetings.length === 0) {
          return asText({ ok: true, message: "No hay reuniones en ese rango.", count: 0 });
        }

        const chatId = deps.getCurrentChatId();

        // Guardar lista completa en KV para cuando llegue callback msel:*
        await deps.kv.set(`meeting-list:${chatId}`, meetings, 30 * 60);

        // Guardar datos individuales también
        for (const m of meetings) {
          await deps.kv.set(`meeting:${chatId}:${m.id}`, m, 30 * 60);
        }

        // Construir mensaje de selección
        const lines = meetings.map((m, i) => {
          const flag = m.hasFocoCal ? " ✦" : "  ";
          const dateStr = formatFechaEs(m.fecha);
          return `${i + 1}.${flag} <b>${m.title}</b> · ${dateStr}`;
        });

        const text = [
          `<b>📋 Meetings ${formatFechaEs(from)}–${formatFechaEs(to)}</b> (${meetings.length})`,
          "",
          lines.join("\n"),
          "",
          "<i>✦ = tiene análisis de Foco CAL</i>",
          "",
          "¿Cuáles cruzamos contra tu Foco?",
        ].join("\n");

        // Botones numerados (máx 5 por fila) + Todas
        type TgButton = { text: string; callback_data: string };
        const numButtons: TgButton[] = meetings.map((m, i) => ({
          text: `${i + 1}`,
          callback_data: `msel:${m.id}`,
        }));
        const rows: TgButton[][] = [];
        for (let i = 0; i < numButtons.length; i += 5) {
          rows.push(numButtons.slice(i, i + 5));
        }
        rows.push([{ text: "✅ Todas", callback_data: "msel:all" }]);

        await tgSend(deps.botToken, chatId, text, { inline_keyboard: rows });

        return asText({ ok: true, count: meetings.length });
      },
    ),
```

- [ ] **Step 2: Compilar**

```bash
npm -w @cos/daemon run build 2>&1 | tail -20
```
Expected: 0 errores.

- [ ] **Step 3: Commit**

```bash
git add daemon-v2/src/agent-tools.ts
git commit -m "feat(meetings): add reviewMeetings tool (on-demand phase 1)"
```

---

## Task 4: Tool `analyzeMeeting` (callback handler)

**Files:**
- Modify: `daemon-v2/src/agent-tools.ts`

- [ ] **Step 1: Agregar tool `analyzeMeeting`**

Insertar después de `reviewMeetings`:

```typescript
    tool(
      "analyzeMeeting",
      "Procesa una reunión para extraer temas del Foco CAL y presentarlos para validación (Nivel 2). " +
      "Llamar cuando llegue callback mlog:{meetingId}:{mode}. " +
      "mode='focoCal': usa el campo Resumen Foco CAL pre-computado (rápido). " +
      "mode='resumen': devuelve el Resumen para que el LLM analice. " +
      "mode='transcript': devuelve instrucciones para que el LLM use notion-fetch. " +
      "Después de llamar este tool con mode='focoCal', usar buildApprovalFlow con los topics " +
      "retornados y confirmVerb='✅ Sí', rejectVerb='⏭ No'. " +
      "Mapping de callbacks jano-wiz-ok: stepApprovalWizard({ action: 'ok' }) → logFocoProgress({ itemText: topic.text, section: topic.section }).",
      {
        meetingId: z.string().describe("Notion page ID de la reunión"),
        mode: z
          .enum(["focoCal", "resumen", "transcript"])
          .describe("Fuente de análisis"),
      },
      async ({ meetingId, mode }) => {
        const chatId = deps.getCurrentChatId();
        const meeting = await deps.kv.get<MeetingNote>(
          `meeting:${chatId}:${meetingId}`,
        );

        if (!meeting) {
          return asText({
            error:
              "Reunión no encontrada en caché. Intenta con reviewMeetings o showMeetingCards primero.",
          });
        }

        if (mode === "focoCal") {
          if (!meeting.resumenFocoCal) {
            return asText({
              error:
                "Esta reunión no tiene Resumen Foco CAL. Usa mode='resumen' o mode='transcript'.",
            });
          }
          const topics: FocoTopic[] = parseFocoCalTopics(meeting.resumenFocoCal);
          return asText({
            ok: true,
            meetingTitle: meeting.title,
            topics,
            instruction:
              `Llama buildApprovalFlow con: ` +
              `title="${meeting.title} — ¿qué logueamos?", ` +
              `items=topics.map(t => ({ id: t.text, label: t.text, meta: t.section })), ` +
              `confirmVerb="✅ Sí", rejectVerb="⏭ No". ` +
              `Cuando llegue jano-wiz-ok, llama stepApprovalWizard({ action: "ok" }) ` +
              `y luego logFocoProgress({ itemText: item.label, section: item.meta }).`,
          });
        }

        if (mode === "resumen") {
          if (!meeting.resumen) {
            return asText({
              error:
                "Esta reunión no tiene Resumen. Usa mode='transcript'.",
            });
          }
          return asText({
            ok: true,
            meetingTitle: meeting.title,
            contentForAnalysis: meeting.resumen,
            instruction:
              `Analiza el contenido de la reunión "${meeting.title}" y extrae qué temas ` +
              `del Foco CAL de Cal se avanzaron (Foco CAL tiene secciones: CAL personal, ` +
              `Prioridades, Rufino, Christian, KPIs, Tareas). ` +
              `Luego llama buildApprovalFlow con los temas encontrados para que Cal valide. ` +
              `confirmVerb="✅ Sí", rejectVerb="⏭ No". ` +
              `Cuando llegue jano-wiz-ok: stepApprovalWizard({ action: "ok" }) → logFocoProgress.`,
          });
        }

        // mode === "transcript"
        return asText({
          ok: true,
          meetingTitle: meeting.title,
          meetingPageId: meetingId,
          instruction:
            `Llama mcp__claude_ai_Notion__notion-fetch con id="${meetingId}" ` +
            `para obtener el body completo de la reunión "${meeting.title}". ` +
            `Extrae el bloque de transcript (máx 8000 caracteres). ` +
            `Analiza qué temas del Foco CAL se avanzaron (secciones: CAL, Prioridades, ` +
            `Rufino, Christian, KPIs, Tareas). ` +
            `Luego llama buildApprovalFlow para validación. ` +
            `confirmVerb="✅ Sí", rejectVerb="⏭ No". ` +
            `Cuando llegue jano-wiz-ok: stepApprovalWizard({ action: "ok" }) → logFocoProgress.`,
        });
      },
    ),
```

- [ ] **Step 2: Compilar**

```bash
npm -w @cos/daemon run build 2>&1 | tail -20
```
Expected: 0 errores.

- [ ] **Step 3: Commit**

```bash
git add daemon-v2/src/agent-tools.ts
git commit -m "feat(meetings): add analyzeMeeting tool"
```

---

## Task 5: Whitelist en `agent-options.ts`

**Files:**
- Modify: `daemon-v2/src/agent-options.ts`

- [ ] **Step 1: Agregar los 3 nuevos tools al array `CLAUDE_AI_COS_TOOLS`**

Buscar el bloque `// Foco CAL — check-ins proactivos y revisión on-demand` (alrededor de línea 176) y agregar debajo:

```typescript
  // Foco CAL — check-ins proactivos y revisión on-demand
  "mcp__cos-tools__getFocoCalStatus",
  "mcp__cos-tools__logFocoProgress",
  // Meetings → Foco Log — tarjetas por meeting, revisión on-demand, análisis
  "mcp__cos-tools__showMeetingCards",
  "mcp__cos-tools__reviewMeetings",
  "mcp__cos-tools__analyzeMeeting",
```

- [ ] **Step 2: Compilar**

```bash
npm -w @cos/daemon run build 2>&1 | tail -20
```

- [ ] **Step 3: Commit**

```bash
git add daemon-v2/src/agent-options.ts
git commit -m "feat(meetings): whitelist showMeetingCards, reviewMeetings, analyzeMeeting"
```

---

## Task 6: Modificar `foco-check.ts` — slot 6pm con meetings

**Files:**
- Modify: `daemon-v2/src/proactive/foco-check.ts`

- [ ] **Step 1: Agregar import de `queryMeetingsByDate` y tipos**

En el bloque de imports:

```typescript
import {
  queryMeetingsByDate,
  formatFechaEs,
  type MeetingNote,
} from "../tools/meeting-notes.js";
```

- [ ] **Step 2: Modificar `runFocoCheckin` para que el slot pm query meetings**

Reemplazar la función existente `runFocoCheckin` (líneas 37-79) por:

```typescript
async function runFocoCheckin(opts: FocoCheckinOpts, slot: Slot): Promise<void> {
  const { kv, chatId, options, setCurrentChatId } = opts;

  const today = new Date().toISOString().slice(0, 10);
  const dedupKey = `foco_checkin_sent:${today}:${slot}`;
  const alreadySent = await kv.get<boolean>(dedupKey);
  if (alreadySent) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "foco_checkin_skip_dedup", slot }));
    return;
  }

  const { section } = await getNextSection(kv);

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
```

- [ ] **Step 3: Modificar `buildPrompt` para aceptar meetings y extender el slot pm**

Reemplazar la firma y el body de `buildPrompt` (líneas 81-116):

```typescript
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
${meetingsBlock}
Tu tarea en ESTE turno (sin desviarte):
${meetingsBlock ? "0. PRIMERO procesa el bloque de meetings (ver abajo). DESPUÉS el check-in de Foco.\n" : ""}1. ${notionStep}
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

  const omitted = meetings.length === 5 ? "\n  (máx 5 mostrados)" : "";

  return `
## Meetings de hoy (${meetings.length}):
${lines.join("\n")}${omitted}

INSTRUCCIONES para meetings — ejecutar ANTES del check-in de Foco:
1. Llama mcp__cos-tools__showMeetingCards con el array meetings de arriba.
   Incluir en cada objeto: id, title, fecha, hasFocoCal (y resumenFocoCal si está disponible).
   Esto envía tarjetas Telegram para que Cal seleccione qué loguear.
2. Después de showMeetingCards, continúa inmediatamente con el check-in de Foco normal.
3. Los callbacks mlog/mskip de las tarjetas llegarán por separado — no los esperes aquí.

Datos de meetings para showMeetingCards:
${JSON.stringify(meetings.map((m) => ({
  id: m.id,
  title: m.title,
  fecha: m.fecha,
  hasFocoCal: m.hasFocoCal,
  resumenFocoCal: m.resumenFocoCal,
  resumen: m.resumen,
})), null, 2)}
`;
}
```

- [ ] **Step 4: Compilar**

```bash
npm -w @cos/daemon run build 2>&1 | tail -20
```
Expected: 0 errores.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/proactive/foco-check.ts
git commit -m "feat(meetings): extend 6pm check-in with today's meetings block"
```

---

## Task 7: Instrucciones de callbacks en `system-prompt.ts`

**Files:**
- Modify: `daemon-v2/src/system-prompt.ts`

- [ ] **Step 1: Leer la sección de callbacks en system-prompt.ts**

```bash
grep -n "jano-wiz\|callback\|mlog\|Foco CAL" "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2/src/system-prompt.ts" | head -30
```

- [ ] **Step 2: Agregar sección de callbacks de meetings**

Localizar el bloque donde se explican los callbacks de foco (buscar "jano-wiz-ok" en el system-prompt) y agregar a continuación:

```typescript
// En el string SYSTEM_PROMPT, agregar esta sección después de las instrucciones de Foco CAL:
`
## Meetings → Foco Log

### Callbacks de tarjetas de reunión (Nivel 1)

Cuando llegue \`[callback] mlog:{meetingId}:{mode}\`:
1. Llama \`analyzeMeeting({ meetingId, mode })\`
2. Si mode="focoCal": el tool retorna topics → llama \`buildApprovalFlow\` con los topics
3. Si mode="resumen" o "transcript": sigue las \`instruction\` del tool result
4. buildApprovalFlow: title="{meetingTitle} — ¿qué logueamos?", confirmVerb="✅ Sí", rejectVerb="⏭ No"
5. Cuando llegue \`jano-wiz-ok\` del flow de topics:
   - \`stepApprovalWizard({ action: "ok" })\` → retorna item con label=tema, meta=sección
   - \`logFocoProgress({ itemText: item.label, section: item.meta, note: null })\`

Cuando llegue \`[callback] mskip:{meetingId}\`:
- Responde con un mensaje corto: "⏭ Saltado" (sin tools, sin análisis)

### Callbacks de selección on-demand (Fase 1 → Fase 2)

Cuando llegue \`[callback] msel:{meetingId}\`:
1. Lee KV \`meeting:{chatId}:{meetingId}\` via \`analyzeMeeting\` (primero llama showMeetingCards para ese meeting)
2. O alternativamente: llama \`showMeetingCards\` con el meeting específico leído del KV
   - Para leer el meeting del KV: llama \`analyzeMeeting({ meetingId, mode: "focoCal" })\` que lo lee internamente
3. Trata el flow igual que un mlog:{meetingId}:focoCal

Cuando llegue \`[callback] msel:all\`:
1. Lee lista completa del KV \`meeting-list:{chatId}\` — nota: no hay tool directo para esto
2. Responde: "Procesando todas las reuniones..." y llama \`showMeetingCards\` con todas (máx 5)
   - Para obtener la lista: el LLM NO tiene acceso directo al KV — responde a Cal confirmando que se procesarán todas y que llame \`reviewMeetings\` de nuevo si es necesario, o gestiona con la info del mensaje original
`
```

**Nota:** El `msel:all` es complejo porque el LLM no puede leer el KV directamente. Solución pragmática: cuando el LLM reciba `msel:all`, llama `reviewMeetings` nuevamente con el mismo rango para regenerar el list y luego llama `showMeetingCards` con las primeras 5. El rango se puede inferir del contexto del mensaje.

- [ ] **Step 3: Encontrar el punto exacto en system-prompt.ts para insertar y hacer el edit**

```bash
grep -n "getFocoCalStatus\|logFocoProgress\|Foco CAL" "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2/src/system-prompt.ts" | tail -10
```

Luego editar el archivo para insertar la nueva sección de callbacks después de las instrucciones de Foco CAL existentes.

- [ ] **Step 4: Compilar**

```bash
npm -w @cos/daemon run build 2>&1 | tail -20
```

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/system-prompt.ts
git commit -m "feat(meetings): add meeting callback instructions to system prompt"
```

---

## Task 8: Agregar progress message en `agent.ts`

**Files:**
- Modify: `daemon-v2/src/agent.ts`

- [ ] **Step 1: Localizar TOOL_MESSAGES**

```bash
grep -n "TOOL_MESSAGES\|showMeeting\|reviewMeeting\|analyzeMeeting" "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2/src/agent.ts" | head -10
```

- [ ] **Step 2: Agregar entradas al TOOL_MESSAGES map**

En el objeto `TOOL_MESSAGES`, agregar:

```typescript
  "mcp__cos-tools__showMeetingCards": "📋 Enviando tarjetas de reuniones...",
  "mcp__cos-tools__reviewMeetings": "🔍 Consultando reuniones en Notion...",
  "mcp__cos-tools__analyzeMeeting": "🧠 Analizando reunión...",
```

- [ ] **Step 3: Compilar**

```bash
npm -w @cos/daemon run build 2>&1 | tail -20
```

- [ ] **Step 4: Commit**

```bash
git add daemon-v2/src/agent.ts
git commit -m "feat(meetings): add progress messages for meeting tools"
```

---

## Task 9: Build, restart y prueba de humo

**Files:** ninguno nuevo

- [ ] **Step 1: Build completo**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm -w @cos/shared run build && npm -w @cos/daemon run build
```
Expected: 0 errores, archivos en `daemon-v2/dist/`.

- [ ] **Step 2: Restart daemon**

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
```

- [ ] **Step 3: Verificar que el daemon arrancó correctamente**

```bash
sleep 3 && launchctl print gui/$(id -u)/com.cal.cos-agent-v2 | grep -E "state|pid"
tail -20 ~/Library/Logs/cos-agent-v2.out.log
```
Expected: `state = running`, logs con `foco_checkins_scheduled`.

- [ ] **Step 4: Prueba de humo — reviewMeetings on-demand**

Enviar por Telegram a @cal_jano_bot:
```
revisa mis meetings de esta semana
```

Expected:
1. Jano llama `reviewMeetings({ from: "2026-05-26", to: "2026-05-26" })` (o el rango de la semana)
2. Aparece lista de meetings con botones numerados
3. Sin errores en logs

- [ ] **Step 5: Verificar logs del daemon**

```bash
tail -30 ~/Library/Logs/cos-agent-v2.out.log
tail -30 ~/Library/Logs/cos-agent-v2.err.log
```

- [ ] **Step 6: Commit final (si hay ajustes menores post-prueba)**

```bash
git add -A
git commit -m "fix(meetings): post-smoke-test adjustments" 2>/dev/null || echo "nada que commitear"
```

---

## Casos edge — checklist de verificación

| Caso | Cómo probar |
|------|-------------|
| No hay meetings hoy | El slot pm no muestra bloque de meetings — check-in normal |
| Meeting sin Resumen Foco CAL | Tarjeta muestra [📄 Analizar][🎙 Transcript][⏭ Saltar] |
| Meeting con Resumen Foco CAL vacío string | `parseFocoCalTopics("")` retorna `[]` → fallback igual que sin campo |
| NOTION_TOKEN faltante | `reviewMeetings` retorna error claro sin crashear el daemon |
| Más de 5 meetings hoy | `showMeetingCards` corta en 5, log incluye `meetingCount: 5` |
| mskip callback | LLM responde "⏭ Saltado" — sin tools ni análisis |
| Transcript muy largo | El LLM toma primeros ~8000 chars según instrucción en system-prompt |

---

## Notas de implementación

- **`NOTION_TOKEN`** ya está en `process.env` (cargado en `index.ts` línea 41 como `requireEnv`). Accesible en los tools via `process.env.NOTION_TOKEN`.
- **KV keys usadas:** `meeting:{chatId}:{meetingId}` (TTL 4h), `meeting-list:{chatId}` (TTL 30min).
- **`msel:all` — limitación:** el LLM no puede leer KV directamente. Si Cal toca [Todas], el LLM debe llamar `reviewMeetings` con el mismo rango para regenerar. Documentar esto en system-prompt como workaround explícito.
- **Approval flow para topics:** usa la misma key `jano-wiz:{chatId}` que el approval flow de Foco CAL. No hay conflicto porque son turnos separados (el meetings flow y el Foco CAL check-in no se superponen en el mismo turno de callbacks).
