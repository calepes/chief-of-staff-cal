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
