import { callNtn } from "../shared/ntn.js";
import { nowInLaPaz } from "../journal-capture.js";
import { BOOKS_DS, TRACKING_DS } from "../tools/books.js";
import { sendCronMessage } from "./rich-send.js";

export interface BooksDailyReportOpts {
  botToken: string;
  chatId: number;
}

interface NotionPage {
  properties: Record<string, unknown>;
}

function ayerLaPaz(): string {
  return nowInLaPaz(new Date(Date.now() - 24 * 60 * 60 * 1000)).slice(0, 10);
}

const ESTADO_EMOJI: Record<string, string> = {
  Reading: "📖", Read: "✅", Goal: "🎯", Focus: "🔥",
  "Stand-By": "⏸️", Reference: "📎", "wish list": "💭",
  "Not started": "⬜", "Por comprar": "🛒",
};

function estadoDeLibro(page: NotionPage): string {
  const props = page.properties as { Estado?: { status?: { name?: string } } };
  return props.Estado?.status?.name ?? "?";
}

function tituloDeSesion(page: NotionPage): string {
  const props = page.properties as {
    "Book Name"?: { rollup?: { array?: Array<{ title?: Array<{ plain_text?: string }> }> } };
  };
  return props["Book Name"]?.rollup?.array?.[0]?.title?.[0]?.plain_text ?? "(libro sin nombre)";
}

function paginasDeSesion(page: NotionPage): number {
  const props = page.properties as { "Avance (pag)"?: { formula?: { number?: number } } };
  return props["Avance (pag)"]?.formula?.number ?? 0;
}

export async function checkBooksDailyReport(opts: BooksDailyReportOpts): Promise<void> {
  const { botToken, chatId } = opts;

  const metaRes = callNtn(`v1/data_sources/${BOOKS_DS}/query`, {
    method: "POST",
    body: { filter: { property: "Planning to read", select: { equals: "2026" } }, page_size: 100 },
  });
  if (!metaRes.ok) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "books_daily_report_meta_error", err: metaRes.error }));
    return;
  }
  const metaBooks = ((metaRes.data as { results?: NotionPage[] }).results ?? []);

  const porEstado = new Map<string, number>();
  for (const b of metaBooks) {
    const estado = estadoDeLibro(b);
    porEstado.set(estado, (porEstado.get(estado) ?? 0) + 1);
  }

  const fecha = ayerLaPaz();
  const trackRes = callNtn(`v1/data_sources/${TRACKING_DS}/query`, {
    method: "POST",
    body: { filter: { property: "Fecha", date: { equals: fecha } }, page_size: 100 },
  });
  if (!trackRes.ok) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "books_daily_report_tracking_error", err: trackRes.error }));
    return;
  }
  const sesiones = ((trackRes.data as { results?: NotionPage[] }).results ?? []);

  const paginasPorLibro = new Map<string, number>();
  for (const s of sesiones) {
    const titulo = tituloDeSesion(s);
    paginasPorLibro.set(titulo, (paginasPorLibro.get(titulo) ?? 0) + paginasDeSesion(s));
  }

  const lines: string[] = [`📚 <b>Libros — Meta 2026</b>`];
  lines.push(`${metaBooks.length} libro${metaBooks.length !== 1 ? "s" : ""} en la meta`);
  const estadoLine = [...porEstado.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([estado, count]) => `${ESTADO_EMOJI[estado] ?? "•"} ${estado}: ${count}`)
    .join(" · ");
  if (estadoLine) lines.push(estadoLine);

  lines.push("");
  lines.push(`📈 <b>Avance de ayer</b> (${fecha})`);
  if (paginasPorLibro.size === 0) {
    lines.push("Sin sesiones de lectura registradas ayer.");
  } else {
    const totalPaginas = [...paginasPorLibro.values()].reduce((a, b) => a + b, 0);
    lines.push(`${totalPaginas} páginas en total`);
    for (const [titulo, paginas] of [...paginasPorLibro.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`• <b>${titulo}</b> — ${paginas} págs`);
    }
  }

  try {
    await sendCronMessage(botToken, { chatId, text: lines.join("\n") });
    console.log(JSON.stringify({ ts: Date.now(), msg: "books_daily_report_sent", metaCount: metaBooks.length, sesionesAyer: sesiones.length }));
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "books_daily_report_send_failed", err: String(err) }));
  }
}
