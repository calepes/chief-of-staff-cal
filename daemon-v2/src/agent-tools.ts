import { tool, startup } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname } from "node:path";
import { getOutlookEvents } from "./tools/outlook.js";
import { manageLearning } from "./tools/learnings.js";
import { searchPlaces, travelTime as calcTravelTime } from "./tools/maps.js";
import { buildApprovalFlowImpl, stepApprovalWizardImpl } from "./tools/approval-flow.js";
import { getWhatsappContacts, saveWhatsappContact, type WaContact } from "./tools/whatsapp.js";
import { pptWizardSaveImpl, pptWizardLoadImpl } from "./tools/ppt-wizard.js";
import type { CfKv } from "./cf-kv.js";
import {
  appendFocoProgress,
  readFocoProgress,
  peekCurrentSection,
  FOCO_PAGE_ID,
  FOCO_KPIS_VIEW_URL,
  FOCO_TAREAS_VIEW_URL,
  FOCO_SECTIONS,
  type FocoProgressEntry,
  type FocoSection,
} from "./tools/foco-cal.js";
import { fetchAsUser } from "./tools/fetch-as-user.js";
import { addDomainAndSync, getStructuredCookies } from "./tools/cookie-jar.js";
import { readPersistedOutput } from "./tools/read-persisted.js";
import { consultarJson } from "./tools/consultar-json.js";
import { formatLearning } from "./learning-file.js";
import { LEARNING_TAGS } from "./learning-types.js";
import { LEARNINGS_PATH } from "./proactive/learning-reflect.js";
import { nowInLaPaz } from "./journal-capture.js";
import { discoverBacklogs, resolveBacklogPath } from "./tools/backlog-discovery.js";
import { buildBacklogMap, readBacklogCompact } from "./tools/backlog-read.js";
import { renderBacklogMap, renderAddProposal, renderDoneProposal } from "./backlog-card.js";
import { BacklogStore } from "./backlog-store.js";
import { fetchAndSummarize } from "./tools/fetch-and-summarize.js";
import { resumirContenido, guardarResumenReadwise, editarPropuestaResumen, revisarPlaylistResumir, revisarStarredResumir, saltarResumen, detenerResumidor, estadoResumidor } from "./tools/resumir.js";
import { addDigestSource, type DigestSection } from "./tools/digest.js";
import { checkKpiCardDaily } from "./proactive/kpi-card-daily.js";
import { checkKpiCardLending } from "./proactive/kpi-card-lending-daily.js";
import { fillDerivedFields } from "./proactive/kpi-ingest-notion.js";
import {
  searchBooks,
  addBook,
  updateBook,
  logReadingProgress,
  setBookCover,
  type EstadoLibro,
  type AddBookParams,
  type UpdateBookParams,
  type LogProgressParams,
  type SetCoverParams,
} from "./tools/books.js";
import { runSubAgent } from "./agent.js";
import {
  formatFechaEs,
  queryMeetingsByDate,
  parseFocoCalTopics,
  escapeHtml,
  tgSend,
  tgEdit,
  type MeetingNote,
  type FocoTopic,
} from "./tools/meeting-notes.js";
// getHealthSummary, getHealthTrend, getWorkouts migradas al MCP global `health`
// (mcp__health__getHealthSummary / getHealthTrend / getWorkouts).
// listTasks, createTask, setTaskStatus, setTaskFecha, setTaskDeadline, getPersonas
// removidas 2026-05-02 — pendientes en Apple Reminders (Personal / Vibe Me), no Notion.
import { executeRemctl } from "./tools/reminders.js";
import { executeClings, thingsWrite } from "./tools/things.js";
import { notionApi, notionPageMarkdown, notionUpdateBody } from "./tools/notion-cli.js";
import { JOURNAL_DB_ID } from "./journal-ids.js";
import { compactJournalRows } from "./tools/journal.js";
import {
  readerListDocuments,
  readerSearchDocuments,
  readerGetDocumentDetails,
  readerCreateDocument,
  readerMoveDocuments,
  readerGetDocumentHighlights,
  readerAddTagsToDocument,
  readerRemoveTagsFromDocument,
  readerBulkEditDocumentMetadata,
  readerListTags,
  readerAddTagsToHighlight,
  readerRemoveTagsFromHighlight,
  readerSetHighlightNotes,
  readerCreateHighlight,
  readwiseSearchHighlights,
  readwiseListHighlights,
  readwiseGetDailyReview,
  readwiseCreateHighlights,
  readwiseUpdateHighlight,
  readwiseDeleteHighlight,
} from "./tools/readwise.js";
import {
  listVacaciones,
  getVacacionDetail,
} from "./tools/schedule-cal.js";
import { fetchNotionAttachments } from "./tools/notion-files.js";
import { enviarDocumentoLocal, enviarFotoLocal, resolveAllowedLocalFile } from "./tools/telegram-files.js";
import { extractPdfFromBuffer, necesitaOcr } from "./tools/pdf-extract.js";
import { analyzePhoto, analyzePdf, notaOcrParcial } from "./tools/vision.js";
import { parseDesignCritique, writeDesignRef } from "./tools/design-refs.js";
import { captureDesignScreenshot } from "./tools/design-capture.js";
import { sendPhoto, sendDocument, sendChatAction } from "@cos/shared";
import {
  resolveTraveler,
  listTravelerKeys,
  generarQrAduana,
  qrPngBuffer,
  enviarFotoBuffer,
  ImpresionUrl,
  getBoaFrequentFlyer,
} from "./tools/qr-aduana.js";

const READ_ONLY = { annotations: { readOnlyHint: true } };

// Tope del TEXTO que sale por un tool result. NO son los 50 K de processDocument:
// aquellos entran por el prompt, mientras que esto pasa por asText/JSON.stringify,
// que es justo el camino del "SDK persisted-output loop" (>~25 KB → el SDK
// persiste el resultado a disco y el modelo reintenta la tool, quemando turnos —
// ver CLAUDE.md). Se usa el mismo 20 K que consultarJson y leerBacklog.
// El margen importa: el umbral es en BYTES, y 20 K chars de español con acentos
// pasados por JSON.stringify pesan bastante más que 20 KB.
const MAX_PDF_CHARS_TOOL = 20_000;

/** Recorta el texto para el tool result y avisa EXPLÍCITAMENTE si hubo recorte. */
function truncarPdf(text: string): { text: string; chars: number; truncado: boolean } {
  if (text.length <= MAX_PDF_CHARS_TOOL) return { text, chars: text.length, truncado: false };
  return {
    text: `${text.slice(0, MAX_PDF_CHARS_TOOL)}\n\n[... truncado a ${MAX_PDF_CHARS_TOOL} chars ...]`,
    chars: text.length,
    truncado: true,
  };
}

function asText(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

export interface ToolDeps {
  botToken: string;
  getCurrentChatId: () => number;
  /** Path del último PDF adjuntado en el chat actual (lo resuelve el daemon, no el modelo). */
  getLastPdfPath?: () => string | undefined;
  gmapsApiKey?: string;
  homePin?: string;
  kv: CfKv;
  cookieJarKv: CfKv;
  getOptions: () => Options;
}

export function buildSdkTools(deps: ToolDeps) {
  return [
    tool(
      "getOutlookEvents",
      "Lee cache pre-procesado de eventos de Outlook (calendario laboral). Args: { when?: 'today'|'tomorrow'|'both' (default today) }. Cache se refresca por cron com.claude.outlook-cache cada 4h. Devuelve [{when, startTime?, title, location?}].",
      { when: z.enum(["today", "tomorrow", "both"]).optional() },
      async ({ when }) => asText(await getOutlookEvents(when)),
      READ_ONLY,
    ),
    tool(
      "searchPlace",
      "Busca un lugar en Google Places (texto libre). Devuelve hasta 5 candidatos con id, name, address, location lat/lng y googleMapsUri. Útil para resolver coords de un destino antes de calcular tiempo de viaje.",
      { query: z.string() },
      async ({ query }) => {
        if (!deps.gmapsApiKey) return asText({ error: "Google Maps API key no configurado" });
        return asText(await searchPlaces(query, { apiKey: deps.gmapsApiKey, homePin: deps.homePin }));
      },
      READ_ONLY,
    ),
    tool(
      "travelTime",
      "Calcula tiempo de viaje en tráfico real desde origen hasta destino (Google Routes API, modo DRIVE traffic-aware). Args: { destLatLng: 'lat,lng', originLatLng?: 'lat,lng' (default HOME_PIN de Cal) }. Devuelve { durationMin, distanceKm }.",
      {
        destLatLng: z.string(),
        originLatLng: z.string().optional(),
      },
      async ({ destLatLng, originLatLng }) => {
        if (!deps.gmapsApiKey) return asText({ error: "Google Maps API key no configurado" });
        return asText(
          await calcTravelTime(destLatLng, { apiKey: deps.gmapsApiKey, homePin: deps.homePin }, originLatLng),
        );
      },
      READ_ONLY,
    ),
    // addLearning migrada al MCP global agent-learnings (evita warm pool stale).
    // Disponible como mcp__agent-learnings__addLearning({ agent: "jano", text }).
    tool(
      "getTokenUsage",
      "Devuelve el consumo real de tokens Claude Max (todos los clientes: CC + web + iOS). % semanal real vía API headers. Llamar cuando Cal pregunte cuánto ha consumido, cómo van los tokens, si va a llegar al límite, o cuál es el estado de la sesión.",
      {},
      async () => {
        const script = `${homedir()}/.claude/scripts/claude-usage.py`;
        const result = spawnSync("python3", [script, "json"], { encoding: "utf8", timeout: 20_000 });
        if (result.error || result.status !== 0) {
          return asText({ error: "No se pudo obtener el consumo de tokens", detail: result.stderr?.trim() });
        }

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(result.stdout);
        } catch {
          return asText({ error: "Respuesta inesperada del script", raw: result.stdout.slice(0, 200) });
        }

        const totalPct = data.total_pct as number;
        const hasLiveData = data.has_live_data as boolean;
        const localTokensW = data.local_tokens_w as number;
        const localBurnPerH = data.local_burn_per_h as number;
        const hRem = data.hours_remaining as number;
        const byDay = data.by_day as Record<string, number>;
        const live = data.live as Record<string, unknown> | undefined;

        const fmtN = (n: number): string => {
          if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
          if (n >= 1e6) return `${Math.round(n / 1e6)}M`;
          return `${Math.round(n / 1e3)}K`;
        };

        const DOW = ["Do", "Lu", "Ma", "Mi", "Ju", "Vi", "Sa"];

        // Bolivia: UTC-4
        const todayLocal = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);

        const sortedDays = Object.keys(byDay).sort();
        const pastDays = sortedDays.filter((d) => d < todayLocal);

        // Semáforo relativo al promedio de días anteriores
        const avgPast =
          pastDays.length > 0
            ? pastDays.reduce((s, d) => s + byDay[d], 0) / pastDays.length
            : 0;
        const semaforo = (w: number): string => {
          if (avgPast === 0) return "⚪";
          const r = w / avgPast;
          if (r <= 1.0) return "🟢";
          if (r <= 1.5) return "🟡";
          if (r <= 2.0) return "🟠";
          return "🔴";
        };

        let tendencia = "—";
        if (pastDays.length >= 2) {
          const yesterW = byDay[pastDays[pastDays.length - 1]];
          const prevW = byDay[pastDays[pastDays.length - 2]];
          if (yesterW < prevW * 0.9) tendencia = "↓ bajando ✅";
          else if (yesterW > prevW * 1.1) tendencia = "↑ subiendo ⚠️";
          else tendencia = "→ estable";
        }

        const rows = sortedDays.slice(-5).map((d) => {
          const [y, m, day] = d.split("-").map(Number);
          const dow = DOW[new Date(y, m - 1, day).getDay()];
          const dd = d.slice(8);
          const w = byDay[d];
          const marker = d === todayLocal ? " <b>←hoy</b>" : "";
          return `${semaforo(w)} <code>${dow}${dd}  ${fmtN(w).padStart(5)}</code>${marker}`;
        });

        const dRem = Math.floor(hRem / 24);
        const hRemMod = Math.floor(hRem % 24);

        const sessionStatus = live?.["5h_status"] as string | undefined;
        const overageActive = live?.["overage_in_use"] as boolean | undefined;
        let statusLine = "";
        if (sessionStatus === "rejected") {
          const h5Rem = Math.ceil(5 - ((live?.["5h_util"] as number) ?? 0) * 5);
          statusLine = `🛑 Sesión pausada · ventana 5h agotada (reset en ~${Math.max(0, h5Rem)}h)`;
        } else if (overageActive) {
          statusLine = "⚡ Overage activo";
        }

        const liveWarning = hasLiveData ? "" : "\n<i>⚠️ Dato de ciclo: caché local (sin conexión a API)</i>";

        const msg = [
          `☀️ <b>Claude Max · ${todayLocal}</b>`,
          "",
          `Ciclo (todos los clientes): <b>${totalPct.toFixed(1)}%</b> · reset en ${dRem}d${hRemMod}h`,
          ...(statusLine ? [statusLine] : []),
          "",
          `📊 CC local — últimos días:`,
          ...rows,
          "",
          `Tendencia: ${tendencia}`,
          `Burn CC: ${fmtN(localBurnPerH)}/h · acumulado ${fmtN(localTokensW)}`,
          liveWarning,
        ]
          .filter((l) => l !== undefined)
          .join("\n");

        return { content: [{ type: "text" as const, text: msg }] };
      },
      READ_ONLY,
    ),
    tool(
      "requestUserLocation",
      "Solicita al usuario que comparta su ubicación GPS vía un botón nativo de Telegram (ReplyKeyboard con request_location). Llamar cuando Cal pida combustible, distancias, o cualquier cosa que requiera coordenadas y NO ha enviado ubicación en la conversación.",
      {},
      async () => {
        const chatId = deps.getCurrentChatId();
        const token = deps.botToken;
        if (!chatId || !token) return asText({ error: "No chatId/token disponible" });
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: "📍 Para calcular distancias necesito tu ubicación. Toca el botón:",
              reply_markup: {
                keyboard: [[{ text: "📍 Compartir ubicación", request_location: true }]],
                one_time_keyboard: true,
                resize_keyboard: true,
              },
            }),
          });
          const data = (await res.json()) as { ok: boolean; description?: string };
          if (!data.ok) return asText({ error: data.description ?? "API error" });
          return asText({ ok: true });
        } catch (err) {
          return asText({ error: String(err) });
        }
      },
    ),
    tool(
      "enviarArchivoNotion",
      [
        "Envía al chat de Telegram el/los archivo(s) adjunto(s) de una página de Notion (PDF, imagen u otro).",
        "Args: { pageId: string (id de la página de Notion que contiene el adjunto), caption?: string (texto corto, solo va en el primer archivo, sin HTML) }.",
        "Lee las propiedades tipo 'files' y los bloques pdf/file/image de la página y MANDA cada archivo directo al chat — NO devuelvas URLs de Notion (expiran).",
        "Después de invocar esta tool NO repitas links ni describas el adjunto: ya se envió. Responde solo una frase corta tipo '📎 Te envié el PDF' (o el error si status != sent).",
        "status: 'sent' (count enviados) · 'empty' (la página no tiene adjuntos) · 'send_failed'/'error'.",
      ].join(" "),
      {
        pageId: z.string(),
        caption: z.string().optional(),
      },
      async ({ pageId, caption }) => {
        const chatId = deps.getCurrentChatId?.();
        const token = deps.botToken;
        if (!chatId || !token) return asText({ status: "error", error: "No chatId/token disponible" });

        const { attachments, error } = fetchNotionAttachments(pageId);
        if (error) return asText({ status: "error", error });
        if (!attachments || attachments.length === 0) return asText({ status: "empty", pageId });

        let sent = 0;
        const errors: string[] = [];
        for (let i = 0; i < attachments.length; i++) {
          const att = attachments[i];
          const extra = i === 0 && caption
            ? { caption: caption.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") }
            : {};
          try {
            await sendChatAction(token, chatId, att.isImage ? "upload_photo" : "upload_document").catch(() => {});
            if (att.isImage) await sendPhoto(token, chatId, att.url, extra);
            else await sendDocument(token, chatId, att.url, extra);
            sent++;
          } catch (err) {
            errors.push(String(err));
          }
        }

        if (sent === 0) return asText({ status: "send_failed", total: attachments.length, errors });
        return asText({ status: "sent", count: sent });
      },
    ),
    tool(
      "enviarDocumentoUrl",
      [
        "Manda al chat, como documento, un archivo que ya está en una URL pública (ej. el boarding pass que devuelve mcp__boa-checkin__confirmBoaCheckin).",
        "Args: { url: string (URL pública y directa del archivo), caption?: string (texto corto, sin HTML) }.",
        "Telegram descarga el archivo server-side desde esa URL — NO la pegues como link en tu texto, mandala SIEMPRE con esta tool.",
        "Después de invocar esta tool no repitas la URL ni la describas: ya se envió. Responde solo una frase corta (o el error si status != sent).",
      ].join(" "),
      {
        url: z.string(),
        caption: z.string().optional(),
      },
      async ({ url, caption }) => {
        const chatId = deps.getCurrentChatId?.();
        const token = deps.botToken;
        if (!chatId || !token) return asText({ status: "error", error: "No chatId/token disponible" });
        try {
          await sendChatAction(token, chatId, "upload_document").catch(() => {});
          await sendDocument(token, chatId, url, caption ? { caption } : {});
          return asText({ status: "sent" });
        } catch (err) {
          return asText({ status: "send_failed", error: String(err) });
        }
      },
    ),
    tool(
      "leerPdfLocal",
      [
        "Relee el ÚLTIMO PDF que Cal adjuntó en este chat — usala cuando te adjuntaron un PDF y el texto NO te llegó en el mensaje, o llegó cortado/ilegible.",
        "NO recibe argumentos: el archivo lo resuelve el daemon, vos no pasás ningún path.",
        "Intenta la capa de texto y, si es un escaneo, hace OCR con visión automáticamente. Devuelve { ok, text, fuente: 'texto'|'ocr', chars, truncado }.",
        "Si truncado es true, leíste solo una parte: decíselo a Cal en vez de afirmar que ese es todo el contenido.",
        "Si devuelve ok:false, explicá en UNA frase que no se pudo leer y ofrecé que te mande una foto de la parte que le interesa — no reintentes.",
      ].join(" "),
      {},
      async () => {
        const pdfPath = deps.getLastPdfPath?.();
        if (!pdfPath) {
          return asText({ ok: false, error: "No hay ningún PDF adjunto reciente en este chat." });
        }
        // Defensa en profundidad: el path lo pone el daemon (no el modelo), pero se
        // revalida igual con el mismo guard que enviarDocumentoLocal/enviarFotoLocal
        // — tmpdir() + realpath ANTES de comparar.
        const resolved = await resolveAllowedLocalFile(pdfPath, /\.pdf$/i);
        if (!resolved) {
          return asText({ ok: false, error: "El PDF adjunto ya no está disponible." });
        }
        try {
          const buf = await readFile(resolved);
          const extracted = await extractPdfFromBuffer(new Uint8Array(buf));
          const texto = extracted.ok ? extracted.text?.trim() || null : null;
          if (!necesitaOcr(texto)) return asText({ ok: true, fuente: "texto", ...truncarPdf(texto!) });

          const res = await analyzePdf({ imagePath: resolved, task: "ocr" });
          const ocr = res.text?.trim() ? res.text.trim() + notaOcrParcial(res.pagesOcr) : null;
          // Mejor de los dos, igual que processDocument: si el OCR sale más pobre
          // que la capa de texto, no tirar lo que ya se tenía.
          const usarOcr = (ocr?.length ?? 0) >= (texto?.length ?? 0);
          const mejor = usarOcr ? ocr : texto;
          if (!mejor) return asText({ ok: false, error: "El PDF no tiene texto legible, ni siquiera con OCR." });
          return asText({ ok: true, fuente: usarOcr ? "ocr" : "texto", ...truncarPdf(mejor) });
        } catch (err) {
          return asText({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
      READ_ONLY,
    ),
    tool(
      "enviarDocumentoLocal",
      [
        "Manda al chat, como documento, un archivo que existe LOCALMENTE en este filesystem (ej. el .pkpass que devuelve mcp__boa-checkin__generateBoaWalletPass) — NO uses esta tool para URLs públicas, para eso está enviarDocumentoUrl.",
        "Args: { path: string (path local absoluto), filename: string (nombre con el que llega a Telegram, ej. 'boarding-pass.pkpass'), caption?: string }.",
        "Después de invocar esta tool no repitas el path ni lo describas: ya se envió. Responde solo una frase corta (o el error si status != sent).",
      ].join(" "),
      {
        path: z.string(),
        filename: z.string(),
        caption: z.string().optional(),
      },
      async ({ path, filename, caption }) => {
        const chatId = deps.getCurrentChatId?.();
        const token = deps.botToken;
        if (!chatId || !token) return asText({ status: "error", error: "No chatId/token disponible" });
        try {
          await sendChatAction(token, chatId, "upload_document").catch(() => {});
          const sent = await enviarDocumentoLocal(token, chatId, path, filename, caption);
          return asText(sent.ok ? { status: "sent" } : { status: "send_failed", error: sent.error });
        } catch (err) {
          return asText({ status: "send_failed", error: String(err) });
        }
      },
    ),
    tool(
      "enviarFotoLocal",
      [
        "Manda al chat una imagen que existe LOCALMENTE en este filesystem (ej. la tarjeta .png con el diseño navy/dorado que devuelve mcp__boa-checkin__generateBoaWalletPass junto al .pkpass) — NO uses esta tool para URLs públicas. Se envía sin recomprimir (preserva transparencia), a diferencia de una foto normal de Telegram.",
        "Args: { path: string (path local absoluto), filename: string (nombre con el que llega a Telegram), caption?: string }.",
        "Después de invocar esta tool no repitas el path ni lo describas: ya se envió. Responde solo una frase corta (o el error si status != sent).",
      ].join(" "),
      {
        path: z.string(),
        filename: z.string(),
        caption: z.string().optional(),
      },
      async ({ path, filename, caption }) => {
        const chatId = deps.getCurrentChatId?.();
        const token = deps.botToken;
        if (!chatId || !token) return asText({ status: "error", error: "No chatId/token disponible" });
        try {
          // upload_document (no upload_photo): enviarFotoLocal manda vía
          // sendDocument para preservar transparencia — ver telegram-files.ts.
          await sendChatAction(token, chatId, "upload_document").catch(() => {});
          const sent = await enviarFotoLocal(token, chatId, path, filename, caption);
          return asText(sent.ok ? { status: "sent" } : { status: "send_failed", error: sent.error });
        } catch (err) {
          return asText({ status: "send_failed", error: String(err) });
        }
      },
    ),
    tool(
      "generarKpiCardYape",
      [
        "Genera y MANDA directo al chat la tarjeta PNG diaria de KPIs de Yape Bolivia (TRX + Activos DAU, con variación % vs. semana anterior) leyendo la DB Notion 'KPIs diarios'. Mismo código que el cron de las 10:00.",
        "Úsalo cuando Cal pida la tarjeta de KPIs on-demand: 'genera la card de hoy', 'mándame la de ayer', 'la tarjeta del 18 de julio', 'ayer y anteayer', etc.",
        "Args: { fechas?: string[] } — una o más fechas en formato YYYY-MM-DD. Sin fechas: la de HOY (fila más reciente). Resolvé 'ayer'/'anteayer' a fecha absoluta vos mismo antes de llamar. Con varias fechas manda una tarjeta por cada una, en orden.",
        "NO uses esto para consultar el valor en texto (eso es notionCli sobre la DB 'KPIs diarios') — esta tool siempre genera y ENVÍA la imagen.",
        "Tras invocar no repitas los números ni describas la tarjeta: ya se mandó. Si una fecha no tiene fila en Notion, a esa fecha le llega un texto de error en vez de la imagen — no lo inventes.",
      ].join(" "),
      {
        fechas: z
          .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de fecha inválido, usar YYYY-MM-DD"))
          .max(10)
          .optional(),
      },
      async ({ fechas }) => {
        const chatId = deps.getCurrentChatId?.();
        const botToken = deps.botToken;
        const notionToken = process.env.NOTION_TOKEN;
        if (!chatId || !botToken) return asText({ status: "error", error: "No chatId/token disponible" });
        if (!notionToken) return asText({ status: "error", error: "NOTION_TOKEN no configurado" });
        const lista = fechas && fechas.length ? fechas : [undefined];
        for (const fecha of lista) {
          await checkKpiCardDaily({ botToken, chatId, notionToken, fecha });
        }
        return asText({ status: "sent", fechas: fechas ?? ["hoy"] });
      },
    ),
    tool(
      "generarKpiCardLending",
      [
        "Genera y MANDA directo al chat la tarjeta PNG del Funnel Yape Lending (Desembolsos + Derivados Agencia, con incremento vs. día anterior) leyendo la DB Notion 'KPIs Yape Lending'. Mismo código que dispara solo el cron apenas llega el mail de Riesgos.",
        "Úsalo cuando Cal pida la tarjeta de Lending on-demand: 'la card de Lending de hoy', 'mándame la tarjeta del funnel de créditos', 'la de Lending del 22 de julio', etc.",
        "Args: { fechas?: string[] } — una o más fechas en formato YYYY-MM-DD. Sin fechas: la fila más reciente. Resolvé 'ayer'/'anteayer' a fecha absoluta vos mismo antes de llamar. Con varias fechas manda una tarjeta por cada una, en orden.",
        "NO uses esto para consultar el valor en texto (eso es notionCli sobre la DB 'KPIs Yape Lending') — esta tool siempre genera y ENVÍA la imagen.",
        "Tras invocar no repitas los números ni describas la tarjeta: ya se mandó. Si una fecha no tiene fila en Notion, a esa fecha le llega un texto de error en vez de la imagen — no lo inventes.",
      ].join(" "),
      {
        fechas: z
          .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de fecha inválido, usar YYYY-MM-DD"))
          .max(10)
          .optional(),
      },
      async ({ fechas }) => {
        const chatId = deps.getCurrentChatId?.();
        const botToken = deps.botToken;
        const notionToken = process.env.NOTION_TOKEN;
        if (!chatId || !botToken) return asText({ status: "error", error: "No chatId/token disponible" });
        if (!notionToken) return asText({ status: "error", error: "NOTION_TOKEN no configurado" });
        const lista = fechas && fechas.length ? fechas : [undefined];
        for (const fecha of lista) {
          await checkKpiCardLending({ botToken, chatId, notionToken, fecha });
        }
        return asText({ status: "sent", fechas: fechas ?? ["más reciente"] });
      },
    ),
    tool(
      "reprocesarKpisDerivadosYape",
      [
        "Recalcula los campos DERIVADOS de la DB Notion 'KPIs diarios' que estén vacíos: Afiliados 7d, y TRX/DAU/Afiliaciones vs. Sem. anterior (%) — nunca pisa un valor que ya esté cargado, solo completa huecos.",
        "NO toca 'vs. Ayer (%)' — esos 3 campos son exclusivamente del PDF de Seguimiento Diario (kpi-ingest-pdf.ts), sin fallback calculado; esta tool no puede llenarlos.",
        "El cron automático (kpi-ingest-check, cada 15 min) SOLO recalcula la fecha del día que acaba de ingestar, no todo el histórico — evita recorrer y reprocesar meses de historial ya resuelto en cada corrida.",
        "Usa esta tool SOLO cuando Cal pida explícitamente un reproceso — ej. 'reprocesa los KPIs derivados', 'recalcula todo el histórico de KPIs', 'faltan derivados del 15 de julio, reprocesa esa fecha'. No la uses proactivamente ni como parte de otro flujo.",
        "Args: { fechas?: string[] } — fechas puntuales YYYY-MM-DD a reprocesar. Sin fechas (o array vacío): TODO el histórico completo (recorre todas las filas de la DB, puede tardar varios segundos).",
        "Devuelve completadosCount/completadosEjemplos (lo que sí se pudo calcular) y noCalculablesCount/noCalculablesEjemplos (lo que sigue sin poder calcularse, con el motivo exacto) — resumilo en 2-3 líneas, no listes cada fila si son muchas.",
      ].join(" "),
      {
        fechas: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de fecha inválido, usar YYYY-MM-DD")).optional(),
      },
      async ({ fechas }) => {
        const notionToken = process.env.NOTION_TOKEN;
        if (!notionToken) return asText({ status: "error", error: "NOTION_TOKEN no configurado" });
        const scope = fechas?.length ? fechas : undefined;
        try {
          const report = await fillDerivedFields(notionToken, scope);
          return asText({
            status: "done",
            alcance: scope ?? "histórico completo",
            completadosCount: report.completados.length,
            completadosEjemplos: report.completados.slice(0, 10),
            noCalculablesCount: report.noCalculables.length,
            noCalculablesEjemplos: report.noCalculables.slice(0, 10),
          });
        } catch (err) {
          return asText({ status: "error", error: String(err) });
        }
      },
    ),
    tool(
      "generarQrAduanaBolivia",
      [
        "Genera el QR de salida/ingreso de Bolivia (Formulario N° 250 de la Aduana — Declaración Jurada) para un viajero y lo MANDA directo al chat como imagen.",
        "Úsalo cuando Cal pida el QR de aduana / Form 250 / 'el papel para el aeropuerto' para él, Noe, Antonia o Catalina. VALIDA de quién es; si viajan varios, genera un QR por cada uno.",
        "Identidad sale de ~/.claude/datos-viaje.json por nombre — cada quien con su propio documento (el CI 17513894 es solo de Cal).",
        "Args: { viajero, tipoViaje?: 'salida'|'ingreso' (default salida), pais (ISO-2 destino/procedencia, ej PE/CO/AR), transporte?: 'AVIÓN'|'BUS'|'VEHÍCULO PARTICULAR'|'TRANSPORTE DE CARGA'|'A PIE'|'OTROS' (default AVIÓN), empresa? (aerolínea), vuelo? (Nº vuelo/placa), motivo: 'Turismo'|'Salud'|'Trabajo'|'Retorno'|'Otros', divisas?: boolean (efectivo entre $10k-$20k, default false), montoUsd? }.",
        "Tras invocar NO repitas el QR ni links: ya se envió la imagen al chat. Responde una frase corta (o el error).",
        "status: 'sent' (ya mandó el QR) · 'traveler_not_found' (incluye 'disponibles') · 'form_error' (rechazo de validación de la Aduana, ver 'error') · 'send_failed'/'error'.",
      ].join(" "),
      {
        viajero: z.string(),
        tipoViaje: z.enum(["salida", "ingreso"]).optional(),
        pais: z.string().describe("ISO-2 país destino (salida) o procedencia (ingreso)"),
        transporte: z
          .enum(["AVIÓN", "BUS", "VEHÍCULO PARTICULAR", "TRANSPORTE DE CARGA", "A PIE", "OTROS"])
          .optional(),
        empresa: z.string().optional(),
        vuelo: z.string().optional(),
        motivo: z.enum(["Turismo", "Salud", "Trabajo", "Retorno", "Otros"]),
        divisas: z.boolean().optional(),
        montoUsd: z.string().optional(),
      },
      async ({ viajero, tipoViaje, pais, transporte, empresa, vuelo, motivo, divisas, montoUsd }) => {
        const chatId = deps.getCurrentChatId?.();
        const token = deps.botToken;
        if (!chatId || !token) return asText({ status: "error", error: "No chatId/token disponible" });

        const t = resolveTraveler(viajero);
        if (!t) return asText({ status: "traveler_not_found", viajero, disponibles: listTravelerKeys() });

        const res = await generarQrAduana(t, {
          tipoViaje: tipoViaje || "salida",
          pais,
          transporte: transporte || "AVIÓN",
          empresa,
          vuelo,
          motivo,
          divisas: divisas || false,
          montoUsd,
        });
        if (!res.ok) return asText({ status: "form_error", error: res.error });

        try {
          const png = await qrPngBuffer(res.qrData!);
          const vueloTxt = vuelo ? ` · ✈️ ${[empresa, vuelo].filter(Boolean).join(" ")}` : "";
          const cap = `🛂 QR ${tipoViaje === "ingreso" ? "Ingreso a" : "Salida de"} Bolivia — Form 250\n${t.nombres} ${t.apellido1}${vueloTxt}\nCódigo: ${res.memorizado}`;
          await sendChatAction(token, chatId, "upload_photo").catch(() => {});
          const sent = await enviarFotoBuffer(token, chatId, png, cap);
          if (!sent.ok) {
            return asText({
              status: "send_failed",
              error: sent.error,
              memorizado: res.memorizado,
              recuperar: ImpresionUrl(res.memorizado!),
            });
          }
          return asText({ status: "sent", memorizado: res.memorizado, recuperar: ImpresionUrl(res.memorizado!) });
        } catch (e) {
          return asText({
            status: "error",
            error: e instanceof Error ? e.message : String(e),
            memorizado: res.memorizado,
          });
        }
      },
    ),
    tool(
      "getBoaFrequentFlyer",
      "Devuelve el número de viajero frecuente (Elévate/BoA) guardado para un viajero en ~/.claude/datos-viaje.json, si existe. Llamar ANTES de preguntarle a Cal el número — solo preguntar si esta tool devuelve numero=null. Args: { viajero: string } (nombre o alias, ej. 'Cal', 'Noe').",
      { viajero: z.string().describe("Nombre o alias del viajero, ej. 'Cal', 'Noe'") },
      async ({ viajero }) => asText({ numero: getBoaFrequentFlyer(viajero) }),
      READ_ONLY,
    ),
    tool(
      "manageLearnEntry",
      "Gestiona un learning del CoS: keep (marcar válido), drop (marcar inválido), promote (válido + promover tier), keepall (batch), dropall (batch). Para keep/drop/promote: id = ID del learning (ej: err-2026-04-28-002). Para keepall/dropall: id = batch_id del archivo ~/.claude/state/learn-batches/<batch_id>. Llamar cuando llegue un [callback] learn:keep|drop|promote|keepall|dropall:<id>.",
      {
        action: z.enum(["keep", "drop", "promote", "keepall", "dropall"]),
        id: z.string().describe("ID del learning o batch_id"),
      },
      async ({ action, id }) => asText(await manageLearning(action, id)),
    ),
    tool(
      "buildApprovalFlow",
      "Crea un flujo de aprobación visual en Telegram cuando hay ≥2 items que Cal necesita revisar individualmente. Envía un summary card con la lista y botones 'Revisar uno a uno' + bulk actions. Guarda el estado del wizard en KV (TTL 30 min). Usar para: Feedbin triage, Reader inbox, reminders pendientes, learnings batch, cualquier lista con ≥2 decisiones individuales donde 'confirmar todos' NO es la respuesta obvia. NO usar para listas informativas ni cuando hay 1 solo item.",
      {
        title: z.string().describe("Título del wizard, ej: 'Feedbin triage', 'Reminders vencidos'"),
        items: z.array(z.object({
          id: z.string().describe("ID opaco que el LLM usa para llamar la acción correspondiente"),
          label: z.string().describe("Texto principal del item visible en el wizard"),
          meta: z.string().optional().describe("Info secundaria: fuente, fecha, categoría, etc."),
        })).describe("Lista de items a revisar"),
        confirmVerb: z.string().optional().describe("Texto del botón confirmar, default '✅ Confirmar'"),
        rejectVerb: z.string().optional().describe("Texto del botón descartar, default '🗑️ Descartar'"),
      },
      async (args) => asText(await buildApprovalFlowImpl(
        { kv: deps.kv, botToken: deps.botToken, getCurrentChatId: deps.getCurrentChatId },
        args,
      )),
    ),
    tool(
      "stepApprovalWizard",
      "Avanza el wizard de aprobación activo. Llamar siempre que llegue [callback] jano-wiz-*. La tool edita el mensaje de Telegram automáticamente y retorna el item actual (con su id) para que el LLM ejecute la acción correspondiente. Mapping de acciones: 'start' (jano-wiz-start), 'ok' (jano-wiz-ok → ejecutar acción: markRead/completeReminder/manageLearnEntry/etc. con item.id), 'no' (jano-wiz-no → no ejecutar acción, avanzar), 'skip' (jano-wiz-skip → saltar sin procesar), 'prev' (jano-wiz-prev), 'back' (jano-wiz-back → volver al resumen), 'bulk-ok' (jano-wiz-all-ok → retorna TODOS los items pendientes para acción bulk), 'bulk-no' (jano-wiz-all-no). Si done=true: responder con confirmación breve. Si item retorna con action 'ok': llamar la tool de acción correspondiente con item.id antes de responder.",
      {
        action: z.enum(["start", "ok", "no", "skip", "prev", "back", "bulk-ok", "bulk-no"]),
      },
      async ({ action }) => asText(await stepApprovalWizardImpl(
        { kv: deps.kv, botToken: deps.botToken, getCurrentChatId: deps.getCurrentChatId },
        { action },
      )),
    ),
    tool(
      "getWhatsappContacts",
      "Lista todos los contactos guardados en ~/.claude/whatsapp-contacts.md. Devuelve array de { nombre, alias?, relacion?, numero } donde numero es el número internacional sin '+' (ej: '59172345678'). Llamar cuando Cal quiera preparar un WhatsApp o buscar un contacto.",
      {},
      async () => asText(await getWhatsappContacts()),
      READ_ONLY,
    ),
    tool(
      "pptWizardSave",
      "Guarda o actualiza el estado del wizard PPT en curso para el chat activo (KV, TTL 2h). Llamar después de cada intercambio del wizard para persistir el progreso: topic (título tentativo), audience (quiénes son + tiempo disponible), step (1=SCQA, 2=Storyline, 3=Tipos de slide, 4=Contenido, 5=Listo), scqa ({ s, c, q, a }), storyline (array de assertions ordenadas), slides (array de slides con assertion, type, mensaje, cuerpo, pendiente). Solo pasar los campos que cambien en este turno — el resto se preserva.",
      {
        topic:     z.string().optional().describe("Título tentativo del deck"),
        audience:  z.string().optional().describe("Audiencia: quiénes son, qué les importa, tiempo disponible"),
        step:      z.number().int().min(1).max(5).optional().describe("Paso actual del wizard: 1=SCQA 2=Storyline 3=Tipos 4=Contenido 5=Done"),
        scqa:      z.object({
          s: z.string().optional(),
          c: z.string().optional(),
          q: z.string().optional(),
          a: z.string().optional(),
        }).optional().describe("Marco SCQA parcial o completo"),
        storyline: z.array(z.string()).optional().describe("Assertions ordenadas que soportan el Answer"),
        slides:    z.array(z.object({
          n:         z.number().int(),
          assertion: z.string(),
          type:      z.enum(["Chart", "Table", "Subtitle", "Framework", "Visual"]),
          mensaje:   z.string().optional(),
          cuerpo:    z.string().optional(),
          pendiente: z.string().optional(),
        })).optional().describe("Slides del deck con assertion-headline y tipo"),
      },
      async (args) => {
        const chatId = deps.getCurrentChatId();
        const state = await pptWizardSaveImpl(deps.kv, chatId, args);
        return asText(state);
      },
    ),
    tool(
      "pptWizardLoad",
      "Lee el estado actual del wizard PPT para el chat activo. Devuelve el objeto PptWizardState (topic, audience, step, scqa, storyline, slides) o null si no hay wizard activo. Llamar al inicio de un turno cuando Cal retoma una PPT o cuando necesitas saber en qué paso estás.",
      {},
      async () => {
        const chatId = deps.getCurrentChatId();
        return asText(await pptWizardLoadImpl(deps.kv, chatId));
      },
      READ_ONLY,
    ),
    tool(
      "saveWhatsappContact",
      "Agrega un contacto nuevo a ~/.claude/whatsapp-contacts.md. Args: { nombre, alias?, relacion?, numero } donde numero es el número internacional sin '+' (ej: '59172345678'). Llamar después de confirmar los datos con Cal.",
      {
        nombre: z.string().describe("Nombre completo"),
        alias: z.string().optional().describe("Alias o apodo — default: primera palabra del nombre"),
        relacion: z.string().optional().describe("Relación con Cal — ej: Agente de viajes, Pareja"),
        numero: z.string().describe("Número internacional sin '+' ni espacios — ej: 59172345678"),
      },
      async (args) => { await saveWhatsappContact(args as WaContact); return asText(`Contacto ${(args as WaContact).nombre} guardado.`); },
    ),
    tool(
      "getFocoCalStatus",
      "Lee el estado del Foco CAL de Cal: progreso local reciente por sección + punteros a los datos en vivo de Notion. " +
      "Llamar cuando Cal pregunte sobre el Foco, su progreso, en qué enfocarse, qué lleva sin mover, " +
      "cómo van los KPIs de Yape Bolivia (DAU, afiliaciones, TRX), o sus tareas de Notion de la semana. " +
      "Después de este tool, usar notionPageMarkdown(focoPageId) para estado de checkboxes, " +
      "notionCli POST /v1/databases/{kpisDbId|tareasDbId}/query para KPIs/tareas.",
      {},
      async () => {
        const progress = readFocoProgress(30);
        const section = await peekCurrentSection(deps.kv);
        return asText({
          recentProgress: progress,
          currentSection: section,
          focoPageId: FOCO_PAGE_ID,
          kpisViewUrl: FOCO_KPIS_VIEW_URL,
          tareaViewUrl: FOCO_TAREAS_VIEW_URL,
        });
      },
      READ_ONLY,
    ),
    tool(
      "consultarJournal",
      "Lee entradas del Journal de reflexión de Cal (DB Notion bajo Mental Health). " +
      "Usar cuando Cal pregunte cómo estuvo su semana, de qué viene hablando, qué ánimo predominó, " +
      "o quiera repasar sus pensamientos. SOLO LECTURA: para GUARDAR un pensamiento Cal usa el " +
      "prefijo 'journal:' o el modo journal del menú — no existe tool de escritura.",
      {
        desde: z.string().describe("Fecha ISO desde la que leer, ej. '2026-07-01'."),
        soloSinRevisar: z
          .boolean()
          .optional()
          .describe("Si es true, solo las entradas que todavía no se destilaron."),
        limite: z
          .number()
          .optional()
          .describe("Cuántas entradas traer (default 15, máximo 30)."),
      },
      async ({ desde, soloSinRevisar, limite }) => {
        const filtros: unknown[] = [{ property: "Fecha y hora", date: { on_or_after: desde } }];
        if (soloSinRevisar) {
          filtros.push({ property: "Estado", select: { equals: "Sin revisar" } });
        }
        const res = notionApi("POST", `/v1/databases/${JOURNAL_DB_ID}/query`, {
          filter: { and: filtros },
          sorts: [{ property: "Fecha y hora", direction: "descending" }],
          page_size: Math.min(30, Math.max(1, Math.round(limite ?? 15))),
        });
        // Compactar ANTES de devolver: las páginas completas de Notion (properties,
        // relations, created_by, parent, url) pesan 1.5-3 KB c/u y dispararían el
        // persisted-output loop del SDK (umbral ~25 KB, ver CLAUDE.md).
        return asText(compactJournalRows(res));
      },
      READ_ONLY,
    ),
    tool(
      "readPersistedOutput",
      "Lee el contenido completo de un archivo persisted-output del SDK (tool result demasiado grande para el contexto). " +
      "Usar EXCLUSIVAMENTE cuando un tool result anterior devuelva un bloque <persisted-output> con un path a ~/.claude/projects/*/tool-results/toolu_*.json. " +
      "Extrae el path del mensaje y pásalo aquí para obtener el contenido completo.",
      { path: z.string().describe("Ruta absoluta al archivo .json del persisted-output") },
      async ({ path }) => asText(readPersistedOutput(path)),
      READ_ONLY,
    ),
    tool(
      "consultarJson",
      "Filtra un archivo persisted-output con una expresión jq, SIN traer el archivo entero al contexto. " +
      "PREFIERE ESTO sobre readPersistedOutput cuando el archivo sea grande (>50 KB) o cuando solo necesites " +
      "parte de los datos: un subconjunto de filas, ciertos campos, un conteo, o un filtro por fecha. " +
      "Ejemplos: '.results | length' (contar), " +
      "'[.results[].properties | {fecha: .Fecha.date.start, trx: .TRX.number}]' (extraer solo 2 campos de cada fila), " +
      "'[.results[] | select(.properties.Fecha.date.start | startswith(\"2026-07\"))]' (filtrar por mes). " +
      "Devuelve la salida de jq (máx 20K chars). Si necesitas menos datos, refina la expresión y vuelve a llamar.",
      {
        path: z.string().describe("Ruta absoluta al archivo .json del persisted-output"),
        jqExpr: z.string().describe("Expresión jq a aplicar, ej. '.results | length'"),
      },
      async ({ path, jqExpr }) => asText(await consultarJson(path, jqExpr)),
      READ_ONLY,
    ),
    tool(
      "recordarAprendizaje",
      "Guarda YA un aprendizaje que Cal pidió explícitamente recordar (se apenda a ~/.cos-agent/learnings.md). " +
      "Usar SOLO cuando Cal lo pida explícito: 'recuerda que...', 'acuérdate de...', 'de ahora en más...', 'no vuelvas a...'. " +
      "NO usarla por iniciativa propia en medio de una tarea — de eso se encarga la reflexión nocturna, que revisa el día " +
      "entero y propone candidatos para que Cal apruebe con botones. " +
      "Tags: 'pref' = preferencia de formato o estilo · 'hecho' = dato sobre Cal o su contexto · " +
      "'err' = error operativo propio a evitar · 'flujo' = secuencia que Cal repite. " +
      "El ack SIEMPRE muestra el texto exacto que quedó guardado, para que Cal pueda corregirlo en el momento.",
      {
        texto: z
          .string()
          .min(5)
          .max(300)
          .describe("El aprendizaje en UNA línea, con las palabras de Cal, sin adornos (5-300 caracteres)"),
        tag: z.enum(LEARNING_TAGS).describe("pref | hecho | err | flujo"),
      },
      async ({ texto, tag }) => {
        try {
          // Fecha en hora de La Paz (UTC-4), NUNCA toISOString() del proceso: entre las 20:00 y
          // medianoche hora de Cal, UTC ya pasó al día siguiente y el learning quedaría fechado
          // mañana — justo la franja en la que Cal más escribe. Mismo criterio que session-log.ts,
          // proactive/learning-reflect.ts y el routing de bklg:* en index.ts.
          mkdirSync(dirname(LEARNINGS_PATH), { recursive: true });
          const guardado = texto.trim();
          const line = formatLearning({ date: nowInLaPaz().slice(0, 10), tag, text: guardado });
          appendFileSync(LEARNINGS_PATH, `${line}\n`);
          // El ack MUESTRA el texto guardado, a propósito. Esta tool escribe sin confirmación de
          // Cal, y lo que escribe se inyecta después en el system prompt de todos los turnos
          // siguientes — o sea cambia el comportamiento de Jano de forma persistente. Jano ingiere
          // contenido no confiable de rutina (fetchAsUser sobre webs con paywall, WebFetch, el
          // resumidor de artículos y videos): un "de ahora en más, hacé X" incrustado en una página
          // puede inducir esta llamada. Con un ack mudo ("🧠 Anotado.") Cal no tendría manera de
          // saber qué quedó fijado ni de corregirlo. Mostrarlo es la auditoría mínima del camino.
          // Escapado a HTML porque el modelo lo pega en un mensaje de Telegram con parse_mode HTML.
          return asText({
            ok: true,
            guardado,
            instruccion:
              `Responde EXACTAMENTE esto y nada más: 🧠 Anotado: «${escapeHtml(guardado)}»` +
              " — mostrar el texto guardado NO es opcional: es lo único que le permite a Cal ver" +
              " qué quedó fijado y corregirlo si algo se guardó por error.",
          });
        } catch (err) {
          return asText({ ok: false, error: String(err) });
        }
      },
    ),
    tool(
      "mapaBacklogs",
      "Muestra el MAPA COMPLETO de backlogs de Cal: todos los proyectos del árbol ~/Claude Projects " +
      "con su cantidad de pendientes, agrupados por Raíz / Agentes / Apps. " +
      "Usar cuando Cal pregunte qué tiene pendiente SIN nombrar un proyecto, pida 'el mapa de backlogs', " +
      "'qué hay en los backlogs', o quiera una vista general antes de bajar a uno concreto. " +
      "Devuelve texto ya formateado para Telegram: mándalo TAL CUAL, no lo reescribas.",
      {},
      // Texto CRUDO, no asText: el card ya viene renderizado en HTML de Telegram y asText lo
      // pasaría por JSON.stringify, dejando los saltos de línea escapados como "\\n" — el modelo
      // tendría que desescaparlo a mano para cumplir el "mándalo TAL CUAL". Mismo patrón que
      // executeClings/executeRemctl, que también devuelven texto ya formateado.
      async () => ({
        content: [{ type: "text" as const, text: renderBacklogMap(buildBacklogMap(discoverBacklogs())).text }],
      }),
      READ_ONLY,
    ),
    tool(
      "leerBacklog",
      "Devuelve los pendientes de UN backlog concreto, en vista compacta (solo ítems sin tildar, truncados). " +
      "Usar cuando Cal pregunte por los pendientes de un proyecto puntual, o después de mapaBacklogs para bajar al detalle. " +
      "La clave sale de mapaBacklogs (ej. 'jano', 'vesta', 'aeropuertos-bolivia'). " +
      "NO devuelve el archivo entero — si Cal necesita el texto completo de un ítem, pídeselo por nombre.",
      {
        proyecto: z.string().describe("Clave del backlog, ej. 'jano'. Si no sabes cuál, llama mapaBacklogs primero."),
      },
      async ({ proyecto }) => {
        try {
          // resolveBacklogPath valida los 4 invariantes (existe, dentro del root, basename,
          // archivo regular) y lanza con un mensaje ya redactado si alguno falla.
          const path = resolveBacklogPath(proyecto);
          const entry = discoverBacklogs().find((e) => e.key === proyecto)!;
          return asText(readBacklogCompact(path, entry.key, entry.label));
        } catch (e) {
          return asText(e instanceof Error ? e.message : String(e));
        }
      },
      READ_ONLY,
    ),
    tool(
      "proponerItemBacklog",
      "Propone AGREGAR un ítem al backlog de un proyecto, o MARCARLO como hecho. NO escribe: manda una tarjeta " +
      "a Telegram con botones para que Cal confirme, y la escritura ocurre cuando él toca ✅. " +
      "Usar cuando Cal dicte una idea, un pendiente o un 'anota esto' durante la charla, y cuando diga que ya terminó algo. " +
      "Redacta el texto en una línea clara y accionable, en las palabras de Cal — no lo adornes ni lo alargues. " +
      "Después de llamar esta tool NO generes texto: la tarjeta es el único canal.",
      {
        proyecto: z.string().describe("Clave del backlog destino, ej. 'jano'. Ante la duda usa 'jano'; Cal puede cambiarlo con un botón."),
        texto: z.string().min(3).describe("Para accion='agregar': el ítem a anotar. Para accion='hecho': texto que identifique el ítem existente."),
        accion: z.enum(["agregar", "hecho"]).describe("'agregar' para un ítem nuevo, 'hecho' para tildar uno existente"),
      },
      async ({ proyecto, texto, accion }) => {
        try {
          const entry = discoverBacklogs().find((e) => e.key === proyecto);
          if (!entry) {
            return asText(
              `No reconozco el backlog "${proyecto}". Disponibles: ${discoverBacklogs().map((e) => e.key).join(", ")}`,
            );
          }
          const chatId = deps.getCurrentChatId();
          const store = new BacklogStore(deps.kv);
          const kind = accion === "agregar" ? "add" : "done";
          const shortId = await store.createProposal(chatId, { kind, key: proyecto, text: texto, path: entry.path });
          const card =
            kind === "add"
              ? renderAddProposal(entry.label, texto, shortId)
              : renderDoneProposal(entry.label, texto, shortId);
          await tgSend(deps.botToken, chatId, card.text, card.keyboard);
          return asText("Tarjeta enviada. No generes texto adicional.");
        } catch (e) {
          return asText(e instanceof Error ? e.message : String(e));
        }
      },
    ),
    tool(
      "fetchAsUser",
      "Hace fetch de una URL usando las cookies de Safari de Cal, permitiendo acceder a contenido paywalled (NYT, FT, The Economist, Substack, El País, etc.) donde Cal tiene suscripción activa. " +
      "Devuelve el texto extraído del HTML (scripts/estilos removidos, máx 50K chars). " +
      "Si no puede leer las cookies (TCC), indica el paso exacto para otorgar permiso. " +
      "Usar cuando Cal comparte un link de un artículo que requiere login o suscripción.",
      { url: z.string().url().describe("URL completa del artículo o página a leer") },
      async ({ url }) => asText(await fetchAsUser(url, deps.cookieJarKv)),
      READ_ONLY,
    ),
    tool(
      "addCookieJarDomain",
      "Agrega un dominio a la whitelist del Cookie Broker (sitios paywalled cuya cookie de sesión de Safari se guarda para poder leerlos sin pedir login) y sincroniza su cookie de inmediato. " +
      "USAR SOLO DESPUÉS de que Cal confirme explícitamente en el chat que quiere agregar ese dominio en particular (ej. respondió 'sí'/'dale' a la pregunta de si lo agrego) — NUNCA llamar esto de forma autónoma ni proponerlo sin que Cal haya pedido leer ese sitio antes. " +
      "REGLA DURA DE SEGURIDAD: solo dominios de medios de noticias/lectura. NUNCA proponer ni intentar con bancos, financieras, Gmail u otro email — el tool los rechaza por código, pero no se lo debe ni ofrecer a Cal.",
      { domain: z.string().describe("Dominio a agregar, ej. 'elcomercio.pe' (sin http:// ni www.)") },
      async ({ domain }) => asText(await addDomainAndSync(domain)),
    ),
    tool(
      "guardarReferenciaDiseno",
      "Captura un screenshot de una URL como referencia de diseño (dashboards, UI, paletas, " +
      "patrones de X/Instagram/webs) y la guarda: navega con un navegador headless (inyectando " +
      "cookies del Cookie Broker si el dominio está whitelisteado, para saltar login walls), " +
      "analiza el screenshot con visión (jerarquía, paleta, spacing, el patrón concreto que lo " +
      "hace bueno) y escribe la ficha + el screenshot en 'Personal/Referencias de Diseño/'. " +
      "Usar cuando Cal comparta un link con intención de guardarlo como inspiración de diseño. " +
      "Después de llamar esta tool, mandá el screenshot a Cal con enviarFotoLocal usando el " +
      "shotPath devuelto y un caption corto (título + tipo). No hace falta pedir confirmación: " +
      "es informativo.",
      {
        url: z.string().url().refine((u) => /^https?:\/\//i.test(u), { message: "Solo se admiten URLs http/https" }).describe("URL del recurso a capturar y guardar"),
        aplicableA: z.string().optional().describe("Apps de Cal a las que aplica esta referencia, SOLO si es evidente por el contexto de la charla (ej. 'Combustible, Presupuesto Privado'). Omitir si no está claro."),
      },
      async ({ url, aplicableA }) => {
        try {
          const hostname = new URL(url).hostname;
          const cookieResult = await getStructuredCookies(hostname, deps.cookieJarKv);
          const capture = await captureDesignScreenshot(url, cookieResult.cookies);
          const analysis = await analyzePhoto({ imagePath: capture.screenshotPath, task: "design_critique" });
          const critique = parseDesignCritique(analysis.text);
          const fecha = nowInLaPaz(new Date()).slice(0, 10);
          const result = writeDesignRef({ fuente: url, fecha, critique, aplicableA }, capture.screenshotPath);
          // screenshotPath (tmpdir(), disref-*.png) es DISTINTO de result.shotPath (la copia
          // permanente en Personal/Referencias de Diseño/shots/) — enviarFotoLocal exige el
          // primero (dentro de tmpdir(), matcheando el patrón disref-*.png); el segundo vive fuera
          // de tmpdir() y con otro nombre, así que enviarFotoLocal lo rechaza si se le pasa ese.
          return asText({
            ok: true,
            ...result,
            screenshotPath: capture.screenshotPath,
            titulo: critique.titulo,
            tipo: critique.tipo,
            tags: critique.tags,
          });
        } catch (e) {
          return asText({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      },
    ),
    tool(
      "fetchAndSummarize",
      "Descarga una URL usando las cookies de Safari de Cal y genera un resumen/análisis en background " +
      "(proceso separado — no afecta el contexto de Jano). " +
      "Usar cuando Cal comparte un link con instrucción de resumir, analizar, extraer puntos clave, etc. " +
      "Envía progress updates y el resultado final como mensajes nuevos en Telegram. " +
      "NO usar fetchAsUser directamente para artículos largos — usar esta tool.",
      {
        url: z.string().url().describe("URL del artículo a procesar"),
        instruction: z.string().describe(
          "Instrucción específica: 'resume los puntos principales', 'extrae las citas más importantes', " +
          "'dame un resumen ejecutivo de 300 palabras', etc."
        ),
      },
      async ({ url, instruction }) => {
        const result = await fetchAndSummarize(
          { botToken: deps.botToken, cookieJarKv: deps.cookieJarKv },
          deps.getCurrentChatId(),
          { url, instruction },
        );
        return asText(result);
      },
      READ_ONLY,
    ),
    tool(
      "resumirContenido",
      "Resumidor universal. Dado un link (artículo incl. paywall/Cloudflare como Stratechery, NYT, FT; video de YouTube; podcast/audio de Apple Podcasts/Overcast/Spotify/link .mp3/RSS) o un TÍTULO de libro, obtiene el contenido con el mecanismo correcto (cookies de Safari de Cal para paywall, yt-dlp+whisper para audio/video, conocimiento propio para libros), genera un resumen DETALLADO en el MISMO idioma del contenido, y lo envía como mensaje(s) nuevo(s) en Telegram. Async/background: responde 'started' al toque y el resumen llega después. " +
      "Usar esta tool (NO fetchAndSummarize ni WebFetch) cuando Cal comparta un link o título con intención de resumir/analizar/'qué dice'. " +
      "Spotify puede fallar por DRM (avisa). Para libros que no conozco, lo dice en vez de inventar.",
      {
        source: z.string().describe("URL (artículo/YouTube/podcast/mp3/RSS) o título de libro a resumir"),
        instruction: z.string().optional().describe("Instrucción opcional extra: 'enfócate en X', 'resumen ejecutivo de 200 palabras', etc. Si se omite, resumen detallado estándar."),
      },
      async ({ source, instruction }) => {
        const result = resumirContenido(
          { botToken: deps.botToken, cookieJarKv: deps.cookieJarKv },
          deps.getCurrentChatId(),
          { source, instruction },
        );
        return asText(result);
      },
      READ_ONLY,
    ),
    tool(
      "guardarResumenReadwise",
      "Paso 2 del resumidor: guarda en Readwise la propuesta pendiente que generó `resumirContenido` (doc con tags + highlights con tag), DESPUÉS de que Cal la confirme o pida cambios. " +
      "Llamar SOLO cuando Cal responde 'guardar'/'archívalo'/'ok guárdalo' o pide ediciones sobre la propuesta de tags/highlights. " +
      "Para confirmar tal cual: llamar sin argumentos. Para ediciones: `tags` (lista final que reemplaza los del doc), `removeHighlights` (índices 1-based a quitar), `retag` (cambiar el tag de un highlight por índice 1-based). " +
      "`fullArticle: true` cuando Cal pide guardar el ARTÍCULO COMPLETO en Reader (no el resumen) — Reader baja el original desde la URL y le aplica los tags (solo aplica a artículos). " +
      "Si no hay propuesta pendiente, avisa a Cal.",
      {
        tags: z.array(z.string()).optional().describe("Lista final de tags del documento (reemplaza la propuesta). Omitir para conservar los propuestos."),
        removeHighlights: z.array(z.number().int().positive()).optional().describe("Índices 1-based de highlights a eliminar de la propuesta."),
        retag: z.array(z.object({ index: z.number().int().positive(), tag: z.string() })).optional().describe("Re-taggear highlights: index 1-based + nuevo tag."),
        fullArticle: z.boolean().optional().describe("true = guardar el artículo COMPLETO en Reader (Reader baja la URL) con los tags, en vez del resumen."),
      },
      async ({ tags, removeHighlights, retag, fullArticle }) => {
        const result = guardarResumenReadwise(
          { botToken: deps.botToken, cookieJarKv: deps.cookieJarKv },
          deps.getCurrentChatId(),
          { tags, removeHighlights, retag, fullArticle },
        );
        return asText(result);
      },
      READ_ONLY,
    ),
    tool(
      "editarPropuestaResumen",
      "Edita la propuesta de resumen pendiente SIN guardarla y re-renderiza la tarjeta (con botones) en su lugar. Usar cuando Cal toca '🏷️ Agregar tag' o '✏️ Editar' (o lo pide por texto). " +
      "Args: `addTags` (agrega tags al doc, conservando los existentes), `setTags` (reemplaza TODOS los tags del doc), `removeHighlights` (índices 1-based a quitar), `retag` (cambiar tag de un highlight por índice 1-based). " +
      "NO guarda en Readwise — después de editar, Cal confirma con '✅ Guardar'. Para guardar usar guardarResumenReadwise.",
      {
        addTags: z.array(z.string()).optional().describe("Tags a AGREGAR al documento (además de los actuales)."),
        setTags: z.array(z.string()).optional().describe("Lista que REEMPLAZA por completo los tags del documento."),
        removeHighlights: z.array(z.number().int().positive()).optional().describe("Índices 1-based de highlights a eliminar."),
        retag: z.array(z.object({ index: z.number().int().positive(), tag: z.string() })).optional().describe("Re-taggear highlights: index 1-based + nuevo tag."),
      },
      async ({ addTags, setTags, removeHighlights, retag }) => {
        const result = editarPropuestaResumen(
          { botToken: deps.botToken, cookieJarKv: deps.cookieJarKv },
          deps.getCurrentChatId(),
          { addTags, setTags, removeHighlights, retag },
        );
        return asText(result);
      },
      READ_ONLY,
    ),
    tool(
      "detenerResumidor",
      "Para la tanda del resumidor: vacía las colas (playlist + starred) y deja de proponer más. Conserva la propuesta ACTUAL (Cal puede guardarla o saltarla). Lo sacado de la cola reaparece si Cal vuelve a 'revisar la playlist/starred'. " +
      "Llamar cuando Cal dice 'para'/'detené'/'basta'/'stop'/'no quiero ver más'/'frená la cola'. La tool avisa en Telegram; devolvé respuesta VACÍA (sin texto).",
      {},
      async () => {
        const result = detenerResumidor({ botToken: deps.botToken, cookieJarKv: deps.cookieJarKv }, deps.getCurrentChatId());
        return asText(result);
      },
      READ_ONLY,
    ),
    tool(
      "estadoResumidor",
      "Reporta qué hay EN CURSO en el resumidor: la propuesta pendiente (título, si está procesándose o lista para guardar, cuántos tags/highlights), la cola de videos de la playlist y la cola de starred de Feedbin por procesar. Llamar cuando Cal pregunta '¿qué está en curso?'/'¿qué tenés pendiente?'/'¿qué hay en la cola?'/'¿qué estás resumiendo?'. Reenviar el resultado tal cual.",
      {},
      async () => {
        const result = estadoResumidor(deps.getCurrentChatId());
        return asText(result);
      },
      READ_ONLY,
    ),
    tool(
      "saltarResumen",
      "Descarta la propuesta de resumen pendiente SIN guardarla en Readwise. Llamar cuando Cal dice 'salta'/'salta este'/'descártalo'/'siguiente'/'no lo guardes' sobre una propuesta. Si la propuesta venía del auto-resumidor de playlist o de starred, avanza automáticamente al siguiente (y al item starred igual se le quita la estrella en Feedbin).",
      {},
      async () => {
        const result = saltarResumen({ botToken: deps.botToken, cookieJarKv: deps.cookieJarKv }, deps.getCurrentChatId());
        return asText(result);
      },
      READ_ONLY,
    ),
    tool(
      "revisarPlaylistResumir",
      "Revisa AHORA la(s) playlist(s) de YouTube configurada(s) para resumir, encola los videos nuevos y empieza a proponer el primero (mismo flujo de checkpoint). Llamar cuando Cal dice 'revisa la playlist'/'hay videos nuevos para resumir'/'corre el resumidor de la playlist'. Normalmente corre solo 1×/día por cron; esta tool es para dispararlo a demanda.",
      {},
      async () => {
        const result = revisarPlaylistResumir({ botToken: deps.botToken, cookieJarKv: deps.cookieJarKv }, deps.getCurrentChatId());
        return asText(result);
      },
      READ_ONLY,
    ),
    tool(
      "revisarStarredResumir",
      "Revisa AHORA los artículos marcados con estrella (starred) en Feedbin, encola los nuevos y empieza a proponer el primero (mismo flujo de checkpoint que la playlist). Llamar cuando Cal dice 'revisa los starred'/'mira mis favoritos de Feedbin'/'resumime los starred'/'mira la lista de estrellas'. Al guardar o saltar cada uno, se des-estrella en Feedbin y avanza al siguiente. Normalmente corre solo 1×/día por cron; esta tool es para dispararlo a demanda.",
      {},
      async () => {
        const result = revisarStarredResumir({ botToken: deps.botToken, cookieJarKv: deps.cookieJarKv }, deps.getCurrentChatId());
        return asText(result);
      },
      READ_ONLY,
    ),
    tool(
      "addDigestSource",
      "Agrega una fuente RSS nueva al Digest Diario (rss-sources.js). Edita el archivo directamente y la pone en la sección correcta ordenada por weight. Llamar cuando Cal quiera agregar un feed de noticias al digest. Args: feedUrl (URL del RSS), feedName (nombre display), section (bolivia|peru|colombia|fintech), weight? (0.5-1.0, default 0.8). Después de confirmar con Cal, recordarle que haga wrangler deploy.",
      {
        feedUrl:  z.string().url().describe("URL completa del feed RSS"),
        feedName: z.string().describe("Nombre display de la fuente, ej: 'Los Tiempos'"),
        section:  z.enum(["bolivia", "peru", "colombia", "fintech"]).describe("Sección del digest"),
        weight:   z.number().min(0.5).max(1.0).optional().describe("Peso editorial 0.5-1.0 (default 0.8). Usar 1.0 para fuentes premium, 0.7-0.8 para secundarias"),
      },
      async ({ feedUrl, feedName, section, weight }) => {
        const result = addDigestSource({ feedUrl, feedName, section: section as DigestSection, weight });
        return asText(result);
      },
    ),
    tool(
      "showMeetingCards",
      "Envía una tarjeta Telegram (Nivel 1) por cada reunión. " +
      "Si meetings se omite o está vacío, lee la lista del KV guardada por reviewMeetings (usar para msel:all). " +
      "Si meetings se pasa explícito, usa esos datos directamente (usar para foco-check pm). " +
      "Cada tarjeta muestra título + fecha y botones para loguear, analizar o saltar. " +
      "También almacena los datos de cada reunión en CF KV para uso posterior por analyzeMeeting. " +
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
        ).max(5).optional().describe(
          "Omitir cuando viene de msel:all — la tool lee del KV. " +
          "Pasar solo cuando el prompt incluye los datos directamente (foco-check pm).",
        ),
      },
      async ({ meetings }) => {
        const chatId = deps.getCurrentChatId();

        const toShow: MeetingNote[] =
          meetings && meetings.length > 0
            ? (meetings as MeetingNote[]).slice(0, 5)
            : ((await deps.kv.get<MeetingNote[]>(`meeting-list:${chatId}`)) ?? []).slice(0, 5);

        if (toShow.length === 0) {
          return asText({ error: "No hay meetings en caché. Llama reviewMeetings primero." });
        }

        let sent = 0;

        for (const m of toShow) {
          // Guardar datos en KV para analyzeMeeting
          await deps.kv.set(
            `meeting:${chatId}:${m.id}`,
            m as MeetingNote,
            4 * 3600,
          );

          const hasFoco = m.hasFocoCal ?? false;
          const flag = hasFoco ? " 🎯" : "";
          const dateStr = formatFechaEs(m.fecha);
          const text = `📋 <b>${escapeHtml(m.title)}</b> · ${dateStr}${flag}`;

          const keyboard = hasFoco
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

          try {
            await tgSend(deps.botToken, chatId, text, keyboard);
            sent++;
          } catch (err) {
            console.error(`showMeetingCards: tgSend failed for ${m.id}:`, err);
          }
        }

        return asText({ ok: true, sent });
      },
    ),
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
        await deps.kv.set(`meeting-list:${chatId}`, meetings, 4 * 3600);

        // Guardar datos individuales también (mismo TTL que showMeetingCards para consistencia)
        for (const m of meetings) {
          await deps.kv.set(`meeting:${chatId}:${m.id}`, m, 4 * 3600);
        }

        // Construir mensaje de selección
        const lines = meetings.map((m, i) => {
          const flag = m.hasFocoCal ? " 🎯" : "";
          const dateStr = formatFechaEs(m.fecha);
          return `${i + 1}. <b>${escapeHtml(m.title)}</b> · <i>${dateStr}</i>${flag}`;
        });

        const text = [
          `<b>📋 Meetings ${formatFechaEs(from)}–${formatFechaEs(to)}</b> (${meetings.length})`,
          "",
          lines.join("\n"),
          "",
          "<i>🎯 = tiene análisis de Foco CAL</i>",
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
    tool(
      "analyzeMeeting",
      "Procesa una reunión para extraer temas del Foco CAL y presentarlos para validación (Nivel 2). " +
      "Llamar cuando llegue callback mlog:{meetingId}:{mode}. " +
      "mode='focoCal': usa el campo Resumen Foco CAL pre-computado (rápido). " +
      "mode='resumen': devuelve el Resumen para que el LLM analice. " +
      "mode='transcript': delega en analyzeTranscriptAgent (lee el transcript en contexto aislado). " +
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
              `items=topics.map((t, i) => ({ id: \`t\${i}\`, label: t.text, meta: t.section })), ` +
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
            `Llama analyzeTranscriptAgent({ meetingId: "${meetingId}", meetingTitle: "${meeting.title.replace(/"/g, "'")}" }). ` +
            `El subagente lee el transcript en un contexto aislado, envía mensajes de estado a Telegram, ` +
            `y retorna los topics directamente. ` +
            `NO leas el transcript directamente — llenaría este contexto.`,
        });
      },
    ),
    tool(
      "analyzeTranscriptAgent",
      "Analiza una reunión para extraer temas del Foco CAL. Auto-selecciona el modo más rápido: " +
      "(1) si tiene Resumen Foco CAL → parse local inmediato, " +
      "(2) si tiene Resumen → devuelve texto para análisis inline del LLM, " +
      "(3) si ninguno → subagente aislado lee el transcript en Notion. " +
      "El título se busca en KV (no lo pase el LLM). Incluye dedup para evitar doble análisis. " +
      "Retorna { ok, topics, instruction } para llamar buildApprovalFlow.",
      {
        meetingId: z.string().describe("Notion page ID de la reunión"),
      },
      async ({ meetingId }) => {
        const chatId = deps.getCurrentChatId();
        const botToken = deps.botToken;

        // Title siempre desde KV — nunca confiar en el LLM para esto
        const meeting = await deps.kv.get<MeetingNote>(`meeting:${chatId}:${meetingId}`);
        const meetingTitle = meeting?.title ?? meetingId;

        const mkInstruction = (topics: FocoTopic[]) => {
          if (topics.length === 0) return `Sin temas del Foco CAL. Informa brevemente a Cal.`;
          const safeTitle = meetingTitle.replace(/"/g, "'");
          return (
            `Llama buildApprovalFlow con: title="${safeTitle} — ¿qué logueamos?", ` +
            `items=topics.map((t, i) => ({ id: \`t\${i}\`, label: t.text, meta: t.section })), ` +
            `confirmVerb="✅ Sí", rejectVerb="⏭ No". ` +
            `Cuando llegue jano-wiz-ok: stepApprovalWizard({ action: "ok" }) → logFocoProgress({ itemText: item.label, section: item.meta }).`
          );
        };

        // Fast path 1: tiene resumenFocoCal → parse local, sin API
        if (meeting?.resumenFocoCal) {
          const topics = parseFocoCalTopics(meeting.resumenFocoCal);
          if (topics.length > 0) {
            return asText({ ok: true, meetingTitle, topics, instruction: mkInstruction(topics) });
          }
        }

        // Fast path 2: tiene resumen → devuelve para análisis inline del LLM
        if (meeting?.resumen) {
          return asText({
            ok: true,
            meetingTitle,
            mode: "resumen",
            contentForAnalysis: meeting.resumen,
            instruction:
              `Analiza el resumen de "${escapeHtml(meetingTitle)}" y extrae temas del Foco CAL ` +
              `(secciones: CAL, Prioridades, Rufino, Christian, KPIs, Tareas). ` +
              `Llama buildApprovalFlow con los temas. confirmVerb="✅ Sí", rejectVerb="⏭ No". ` +
              `Cuando llegue jano-wiz-ok: stepApprovalWizard → logFocoProgress.`,
          });
        }

        // Dedup: evita que el subagente se lance dos veces para el mismo meeting
        const dedupKey = `transcript_analyzed:${chatId}:${meetingId}`;
        const alreadyDone = await deps.kv.get<boolean>(dedupKey);
        if (alreadyDone) {
          return asText({
            ok: false,
            error: `Transcript de "${meetingTitle}" ya fue analizado en este ciclo. Usa el resultado anterior.`,
          });
        }
        await deps.kv.set(dedupKey, true, 4 * 3600);

        // Slow path: subagente aislado con notionPageMarkdown.
        // Un solo mensaje de estado que se edita en cada fase (no pila de mensajes nuevos).
        const statusMsgId = await tgSend(botToken, chatId,
          `🔍 Leyendo transcript de <b>${escapeHtml(meetingTitle)}</b>...`,
        ).catch(() => 0);

        let subResult = "[]";
        try {
          const subOptions: Options = {
            ...deps.getOptions(),
            allowedTools: ["mcp__cos-tools__notionPageMarkdown"],
            maxTurns: 6,
            systemPrompt: [
              "You are Cal's Foco CAL analyzer. Cal leads Yape Bolivia (mobile payment app).",
              "Read the Notion meeting page via notionPageMarkdown({ pageId }), read the transcript/notes, and extract ACTIONABLE items.",
              "",
              "Cal's Foco CAL has 6 sections — map every item to exactly one:",
              "• CAL — Cal's own strategic objectives, personal leadership decisions, things only Cal can decide",
              "• Prioridades — What must be prioritized this week/sprint: key trade-offs, scope decisions, focus shifts",
              "• Rufino — Topics involving Rufino Arribas (BCP Bolivia stakeholder): commitments, asks, follow-ups",
              "• Christian — Topics involving Christian Hausher (BCP Bolivia): decisions, dependencies, action items",
              "• KPIs — Yape Bolivia metrics: DAU, TRX (transactions), Afiliaciones (new users). Include specific numbers or targets when mentioned.",
              "• Tareas — Concrete tasks: who does what by when. Must be specific and actionable.",
              "",
              "EXTRACTION RULES:",
              "1. Only extract ACTIONABLE items — something to DO, DECIDE, or FOLLOW UP on",
              "2. Skip pure FYI/status items unless they trigger a required action",
              "3. Be specific: 'Definir roadmap Q3 con Gonzo' NOT 'discuss strategy'",
              "4. Section mapping priority: if it mentions Rufino → Rufino; if it mentions Christian → Christian; if KPI number → KPIs; if concrete task → Tareas; if strategic decision → CAL or Prioridades",
              "5. Max 8 items. Prefer quality over quantity.",
              "",
              'Return ONLY a valid JSON array, no other text: [{"text": "item in Spanish", "section": "SectionName"}, ...]',
              "If no actionable items found, return: []",
            ].join("\n"),
          };

          const subWarm = await startup({ options: subOptions });

          if (statusMsgId) {
            await tgEdit(botToken, chatId, statusMsgId, "🧠 Analizando temas del Foco CAL...").catch(() => {});
          }

          const subPrompt =
            `Read the Notion page body via notionPageMarkdown({ pageId: "${meetingId}" }). ` +
            `Focus on transcript, notas, acuerdos, and follow-up sections. ` +
            `Extract actionable Foco CAL items following the system prompt rules. ` +
            `Return ONLY the JSON array.`;

          const { reply } = await runSubAgent(subWarm, subPrompt);
          subResult = reply;
        } catch (err) {
          console.error("analyzeTranscriptAgent: sub-agent error:", err);
          if (statusMsgId) {
            await tgEdit(botToken, chatId, statusMsgId, `⚠️ Error leyendo transcript de <b>${escapeHtml(meetingTitle)}</b>.`).catch(() => {});
          }
          return asText({ ok: false, error: String(err).slice(0, 200), topics: [] });
        }

        const VALID_SECTIONS = new Set(["CAL", "Prioridades", "Rufino", "Christian", "KPIs", "Tareas"]);
        let topics: FocoTopic[] = [];
        try {
          const jsonMatch = subResult.match(/\[[\s\S]*?\]/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]) as Array<{ text?: unknown; section?: unknown }>;
            topics = parsed
              .filter((t) => typeof t.text === "string" && (t.text as string).length > 5)
              .map((t) => ({
                text: (t.text as string).trim(),
                section: (VALID_SECTIONS.has(String(t.section)) ? String(t.section) : "CAL") as FocoSection,
              }))
              .slice(0, 8);
          }
        } catch {
          // Keep empty on parse error
        }

        const finalStatusText = topics.length === 0
          ? `⚠️ <b>${escapeHtml(meetingTitle)}</b> — sin temas accionables del Foco CAL`
          : `✅ <b>${escapeHtml(meetingTitle)}</b> — ${topics.length} tema${topics.length === 1 ? "" : "s"}`;

        if (statusMsgId) {
          await tgEdit(botToken, chatId, statusMsgId, finalStatusText).catch(() => {});
        } else {
          await tgSend(botToken, chatId, finalStatusText).catch(() => {});
        }

        return asText({ ok: true, meetingTitle, topics, instruction: mkInstruction(topics) });
      },
    ),
    tool(
      "logFocoProgress",
      "Loggea el avance de Cal en un item del Foco CAL. " +
      "Llamar cuando Cal confirme 'hecho' en un check-in del Foco (via jano-wiz-ok → stepApprovalWizard → logFocoProgress), " +
      "o cuando Cal mencione explícitamente haber completado o avanzado algo del Foco CAL. " +
      "Retorna string de confirmación.",
      {
        itemText: z.string().describe("Texto del item tal como aparece en el Foco CAL"),
        section: z
          .enum(FOCO_SECTIONS)
          .describe("Sección del Foco CAL"),
        note: z.string().optional().describe("Nota opcional de Cal sobre el avance"),
      },
      async ({ itemText, section, note }) => {
        const now = new Date();
        const entry: FocoProgressEntry = {
          date: now.toISOString().slice(0, 10),
          ts: Math.floor(now.getTime() / 1000),
          section: section as FocoSection,
          itemText,
          note: note ?? null,
        };
        appendFocoProgress(entry);
        return asText(`Progreso loggeado: ${itemText}`);
      },
    ),
    tool(
      "searchBooks",
      "Busca libros en la BD de Notion de Cal. Filtra por nombre y/o estado. Devuelve lista con título, estado, % avance y link.",
      {
        query:  z.string().optional().describe("Texto a buscar en el título del libro"),
        estado: z.enum(["Goal","Reading","Read","Focus","Stand-By","Reference","wish list"]).optional(),
      },
      async ({ query, estado }) =>
        asText(await searchBooks(query, estado as EstadoLibro | undefined)),
      READ_ONLY,
    ),
    tool(
      "addBook",
      "Agrega un libro nuevo a la BD de Notion. Busca y setea el cover automáticamente si hay ISBN o título. Setea cover e icono con la misma imagen.",
      {
        name:           z.string().describe("Título del libro"),
        subtitle:       z.string().optional(),
        isbn:           z.string().optional(),
        estado:         z.enum(["Goal","Reading","Read","Focus","Stand-By","Reference","wish list"]),
        planningToRead: z.enum(["2021","2022","2023","2024","2025","2026"]).optional(),
        totalPaginas:   z.number().int().positive().optional(),
        startDate:      z.string().optional().describe("ISO date YYYY-MM-DD"),
        finishDate:     z.string().optional().describe("ISO date YYYY-MM-DD"),
        url:            z.string().optional().describe("URL del libro (Apple Books, Amazon, etc.)"),
        fetchCover:     z.boolean().optional().describe("Buscar y setear cover automáticamente. Default true."),
      },
      async (params) => asText(await addBook(params as AddBookParams)),
    ),
    tool(
      "updateBook",
      "Actualiza propiedades de un libro existente en la BD de Notion. Solo actualiza los campos provistos.",
      {
        pageId:         z.string().describe("ID de la página Notion del libro"),
        estado:         z.enum(["Goal","Reading","Read","Focus","Stand-By","Reference","wish list"]).optional(),
        rating:         z.enum(["🥱","😶","😊","😍"]).optional(),
        startDate:      z.string().optional().describe("ISO date YYYY-MM-DD"),
        finishDate:     z.string().optional().describe("ISO date YYYY-MM-DD"),
        totalPaginas:   z.number().int().positive().optional(),
        isbn:           z.string().optional(),
        subtitle:       z.string().optional(),
        url:            z.string().optional(),
        planningToRead: z.enum(["2021","2022","2023","2024","2025","2026"]).optional(),
      },
      async (params) => asText(await updateBook(params as UpdateBookParams)),
    ),
    tool(
      "logReadingProgress",
      "Registra una sesión de lectura en el tracking de libros. El % inicial se auto-detecta del último registro existente (no pedir a Cal). Solo necesitas el % final y opcionalmente la fecha. Porcentajes decimales: 0.10 = 10%, 0.25 = 25%.",
      {
        pageId:            z.string().describe("ID de la página Notion del libro"),
        porcentajeFinal:   z.number().min(0).max(1).describe("% al final de la sesión (0.0–1.0)"),
        porcentajeInicial: z.number().min(0).max(1).optional().describe("% al inicio — omitir para auto-detectar del último registro."),
        fecha:             z.string().optional().describe("ISO date YYYY-MM-DD. Default: hoy."),
      },
      async (params) => asText(await logReadingProgress(params as LogProgressParams)),
    ),
    tool(
      "setBookCover",
      "Busca el cover del libro en internet y lo aplica como banner e ícono de la página en Notion. Orden de fuentes: Google Books (primario) → Open Library por ISBN → Goodreads search (fallback final).",
      {
        pageId: z.string().describe("ID de la página Notion del libro"),
        isbn:   z.string().optional(),
        title:  z.string().optional().describe("Título del libro para búsqueda si no hay ISBN"),
        author: z.string().optional().describe("Autor para refinar la búsqueda"),
      },
      async (params) => asText(await setBookCover(params as SetCoverParams)),
    ),
    tool(
      "executeRemctl",
      "Lee y escribe Apple Reminders via remctl CLI. SOLO para FAMILIA y MERCADO (las tareas/proyectos PERSONALES de Cal viven en Things — usar executeClings). Usar --json siempre. Ejemplos: ['lists','--json'] · ['show','Tareas Familia','--json'] · ['today','--json'] · ['add','Mercado','Leche','--json'] · ['done','<id>','--json'] · ['delete','<id>','--force','--json']. El <id> es el campo 'id' del --json. Listas de Cal en Reminders: Tareas Familia · Mercado · Colegio AntoCata.",
      { args: z.array(z.string()).describe("Array de argumentos para remctl, sin incluir el binario. Ej: ['show','Tareas Familia','--json']") },
      async ({ args }) => ({ content: [{ type: "text" as const, text: await executeRemctl(args) }] }),
    ),
    tool(
      "executeClings",
      "LECTURAS de Things 3 (tareas/proyectos PERSONALES de Cal). SOLO read-only — para CREAR/MODIFICAR usar thingsWrite. Usar --json siempre. Subcomandos: ['today','--json'] · ['inbox','--json'] · ['anytime','--json'] · ['upcoming','--json'] · ['someday','--json'] · ['logbook','--json'] (completadas) · ['projects','--json'] (listar proyectos — resolver nombre exacto antes de crear) · ['areas','--json'] · ['tags','--json'] · ['search','texto','--json'] · ['show','<id>','--json'] · ['stats','--json'] · ['filter','<query>','--json']. El <id>/<uuid> sale de estas lecturas. Áreas de Cal: '⚡️ Cal'. NO usar add/complete/delete/update acá (cuelgan por TCC bajo el daemon).",
      { args: z.array(z.string()).describe("Argumentos read-only para clings. Ej: ['today','--json'], ['projects','--json'], ['search','vinos','--json']") },
      async ({ args }) => ({ content: [{ type: "text" as const, text: await executeClings(args) }] }),
    ),
    tool(
      "thingsWrite",
      "ESCRIBE en Things 3 (crear/modificar/completar/cancelar tareas y proyectos personales) vía URL scheme — headless-safe. command='add' crea TAREA, 'add-project' crea PROYECTO, 'update' modifica tarea (requiere id), 'update-project' modifica/mueve proyecto (requiere id). IMPORTANTE: para TAREAS usar 'list' (nombre del proyecto/área contenedora); para PROYECTOS usar 'area' (nombre del área, ej. '⚡️ Cal') — NO 'list'. Mover un proyecto a un área: {command:'update-project', id:'<uuid>', area:'⚡️ Cal'}. COMPLETAR: {command:'update', id, completed:true}. CANCELAR: +canceled:true. 'notes' soporta saltos de línea. 'when'=today|tomorrow|evening|anytime|someday|YYYY-MM-DD. El auth-token se agrega solo. Resolver nombres exactos de proyecto/área con executeClings ['projects','--json'] / ['areas','--json'] primero. Ejemplos: crear tarea {command:'add', title:'Llamar a X', notes:'tel:...', list:'Pascal'} · crear proyecto en área {command:'add-project', title:'Mi proyecto', area:'⚡️ Cal'}.",
      {
        command: z.enum(["add", "update", "add-project", "update-project"]),
        id: z.string().optional(),
        title: z.string().optional(),
        notes: z.string().optional(),
        when: z.string().optional(),
        deadline: z.string().optional(),
        tags: z.string().optional(),
        list: z.string().optional().describe("Para TAREAS (add): proyecto o área contenedora"),
        area: z.string().optional().describe("Para PROYECTOS (add-project/update-project): nombre del área"),
        checklistItems: z.string().optional(),
        completed: z.boolean().optional(),
        canceled: z.boolean().optional(),
      },
      async (p) => ({ content: [{ type: "text" as const, text: await thingsWrite(p) }] }),
    ),

    // ── Readwise Reader ─────────────────────────────────────────────────────────
    tool(
      "readerListDocuments",
      "Lista documentos en Readwise Reader. location: 'new'=inbox, 'later', 'shortlist', 'archive', 'feed' (solo si Cal pide feed/RSS explícitamente). SIEMPRE pasar limit≤20 para evitar thrashing de contexto. Devuelve {count, nextPageCursor, results:[]}.",
      {
        location: z.enum(["new", "later", "shortlist", "archive", "feed"]).optional(),
        category: z.string().optional().describe("article|email|rss|pdf|epub|tweet|video|podcast|audiobook"),
        limit: z.number().int().min(1).max(20).optional().describe("Máx 20. Default 20 — SIEMPRE incluir."),
        pageCursor: z.string().optional().describe("Cursor de paginación devuelto por llamada anterior"),
        id: z.string().optional().describe("ID de un documento específico"),
        updatedAfter: z.string().optional().describe("ISO 8601 datetime"),
        tag: z.string().optional().describe("Filtrar por tag"),
        responseFields: z.string().optional().describe("Campos a incluir (comma-separated) — omitir para todos"),
      },
      async (p) => asText(readerListDocuments({ ...p, limit: p.limit ?? 20 })),
      READ_ONLY,
    ),
    tool(
      "readerSearchDocuments",
      "Busca documentos en Readwise Reader por contenido (hybrid search). No busca en feed — solo library (new/later/shortlist/archive). SIEMPRE pasar limit≤20.",
      {
        query: z.string().describe("Texto a buscar (required)"),
        limit: z.number().int().min(1).max(20).optional().describe("Máx 20. Default 20."),
        locationIn: z.array(z.enum(["new", "later", "shortlist", "archive"])).optional().describe("Filtrar por ubicaciones"),
        categoryIn: z.string().optional(),
        authorSearch: z.string().optional(),
        titleSearch: z.string().optional(),
        tagsSearch: z.string().optional(),
        tagsIn: z.string().optional(),
      },
      async (p) => asText(readerSearchDocuments({ ...p, limit: p.limit ?? 20 })),
      READ_ONLY,
    ),
    tool(
      "readerGetDocumentDetails",
      "Obtiene detalles completos de un documento de Reader, incluyendo Markdown content, summary, highlights. Usar con el ID obtenido de readerListDocuments o readerSearchDocuments.",
      { documentId: z.string().describe("ID del documento") },
      async ({ documentId }) => asText(readerGetDocumentDetails(documentId)),
      READ_ONLY,
    ),
    tool(
      "readerCreateDocument",
      "Guarda una URL en Readwise Reader. Reader intentará scraping si no se provee html/markdown. Usar cuando Cal quiere guardar un artículo para leer.",
      {
        url: z.string().url().describe("URL del documento a guardar"),
        title: z.string().optional(),
        author: z.string().optional(),
        summary: z.string().optional(),
        tags: z.array(z.string()).optional(),
        notes: z.string().optional().describe("Nota top-level del documento"),
        category: z.string().optional().describe("article|email|rss|pdf|epub|tweet|video|podcast|audiobook"),
      },
      async (p) => asText(readerCreateDocument(p)),
    ),
    tool(
      "readerMoveDocuments",
      "Mueve uno o más documentos de Reader a otra ubicación (inbox/later/shortlist/archive). Máx 50 por llamada. Rate limit: 20 llamadas/min — batch IDs en una sola llamada.",
      {
        documentIds: z.array(z.string()).min(1).max(50).describe("IDs de los documentos a mover"),
        location: z.enum(["new", "later", "shortlist", "archive"]).describe("Destino"),
      },
      async ({ documentIds, location }) => asText(readerMoveDocuments(documentIds, location)),
    ),
    tool(
      "readerGetDocumentHighlights",
      "Obtiene los highlights de un documento de Reader.",
      { documentId: z.string().describe("ID del documento") },
      async ({ documentId }) => asText(readerGetDocumentHighlights(documentId)),
      READ_ONLY,
    ),
    tool(
      "readerAddTagsToDocument",
      "Agrega tags a un documento de Reader.",
      {
        documentId: z.string().describe("ID del documento"),
        tagNames: z.array(z.string()).min(1).describe("Tags a agregar"),
      },
      async ({ documentId, tagNames }) => asText(readerAddTagsToDocument(documentId, tagNames)),
    ),
    tool(
      "readerRemoveTagsFromDocument",
      "Elimina tags de un documento de Reader.",
      {
        documentId: z.string().describe("ID del documento"),
        tagNames: z.array(z.string()).min(1).describe("Tags a eliminar"),
      },
      async ({ documentId, tagNames }) => asText(readerRemoveTagsFromDocument(documentId, tagNames)),
    ),
    tool(
      "readerBulkEditDocumentMetadata",
      "Edita metadata de múltiples documentos en una sola llamada. Máx 50 por llamada. Rate limit compartido con readerMoveDocuments.",
      {
        documents: z.array(z.object({
          document_id: z.string(),
          seen: z.boolean().optional(),
          location: z.enum(["new","later","shortlist","archive"]).optional(),
          tags: z.array(z.string()).optional(),
        })).min(1).max(50),
      },
      async ({ documents }) => asText(readerBulkEditDocumentMetadata(documents)),
    ),
    tool(
      "readerListTags",
      "Lista todos los tags disponibles en Readwise Reader.",
      {},
      async () => asText(readerListTags()),
      READ_ONLY,
    ),
    tool(
      "readerAddTagsToHighlight",
      "Agrega tags a un highlight de un documento de Reader.",
      {
        documentId: z.string().describe("ID del documento que contiene el highlight"),
        highlightDocumentId: z.string().describe("ID del highlight"),
        tagNames: z.array(z.string()).min(1),
      },
      async ({ documentId, highlightDocumentId, tagNames }) =>
        asText(readerAddTagsToHighlight(documentId, highlightDocumentId, tagNames)),
    ),
    tool(
      "readerRemoveTagsFromHighlight",
      "Elimina tags de un highlight de un documento de Reader.",
      {
        documentId: z.string().describe("ID del documento que contiene el highlight"),
        highlightDocumentId: z.string().describe("ID del highlight"),
        tagNames: z.array(z.string()).min(1),
      },
      async ({ documentId, highlightDocumentId, tagNames }) =>
        asText(readerRemoveTagsFromHighlight(documentId, highlightDocumentId, tagNames)),
    ),
    tool(
      "readerSetHighlightNotes",
      "Setea la nota de un highlight de Reader. Pasar notes=null para limpiar la nota.",
      {
        documentId: z.string().describe("ID del documento"),
        highlightDocumentId: z.string().describe("ID del highlight"),
        notes: z.string().nullable().describe("Nota a setear, o null para limpiar"),
      },
      async ({ documentId, highlightDocumentId, notes }) =>
        asText(readerSetHighlightNotes(documentId, highlightDocumentId, notes)),
    ),
    tool(
      "readerCreateHighlight",
      "Crea un highlight en un documento de Reader especificando el fragmento HTML exacto a resaltar.",
      {
        documentId: z.string().describe("ID del documento"),
        htmlContent: z.string().describe("Fragmento HTML exacto a resaltar — copiar verbatim del html_content del documento"),
        tags: z.array(z.string()).optional(),
        note: z.string().optional(),
      },
      async (p) => asText(readerCreateHighlight(p)),
    ),

    // ── Readwise classic highlights ─────────────────────────────────────────────
    tool(
      "readwiseSearchHighlights",
      "Busca highlights de Readwise (libros, artículos) por semántica. SIEMPRE pasar limit≤20.",
      {
        vectorSearchTerm: z.string().describe("Término de búsqueda semántica (required)"),
        fullTextQueries: z.string().optional().describe("Búsqueda adicional full-text (mejora precisión)"),
        limit: z.number().int().min(1).max(20).optional().describe("Máx 20. Default 20."),
      },
      async (p) => asText(readwiseSearchHighlights({ ...p, limit: p.limit ?? 20 })),
      READ_ONLY,
    ),
    tool(
      "readwiseListHighlights",
      "Lista highlights de Readwise. Siempre pasar bookId cuando sea posible y pageSize≤20. Sin bookId, preferir readwiseSearchHighlights.",
      {
        pageSize: z.number().int().min(1).max(20).optional().describe("Máx 20. Default 20."),
        page: z.number().int().optional(),
        bookId: z.string().optional().describe("Filtrar por libro — recomendado para reducir resultados"),
        responseFields: z.string().optional().describe("Campos a incluir (comma-separated)"),
      },
      async (p) => asText(readwiseListHighlights({ ...p, pageSize: p.pageSize ?? 20 })),
      READ_ONLY,
    ),
    tool(
      "readwiseGetDailyReview",
      "Obtiene el daily review de highlights de Readwise para hoy (selección por spaced repetition). Incluye URL para completar el review interactivamente.",
      {},
      async () => asText(readwiseGetDailyReview()),
      READ_ONLY,
    ),
    tool(
      "readwiseCreateHighlights",
      "Crea uno o más highlights en Readwise (libros/artículos). Para highlights de documentos de Reader, usar readerCreateHighlight.",
      {
        highlights: z.array(z.object({
          text: z.string().describe("Texto del highlight"),
          title: z.string().optional().describe("Título del libro/artículo"),
          author: z.string().optional(),
          source_url: z.string().optional(),
          note: z.string().optional(),
          highlighted_at: z.string().optional().describe("ISO 8601 datetime"),
        })).min(1),
      },
      async ({ highlights }) => asText(readwiseCreateHighlights(highlights)),
    ),
    tool(
      "readwiseUpdateHighlight",
      "Actualiza un highlight de Readwise: texto, nota, color y/o tags.",
      {
        highlightId: z.union([z.number(), z.string()]).describe("ID del highlight"),
        text: z.string().optional().describe("Nuevo texto"),
        note: z.string().optional().describe("Nueva nota"),
        color: z.enum(["yellow","blue","pink","orange","green","purple"]).optional(),
        addTags: z.array(z.string()).optional().describe("Tags a agregar"),
        removeTags: z.array(z.string()).optional().describe("Tags a eliminar"),
      },
      async (p) => asText(readwiseUpdateHighlight(p)),
    ),
    tool(
      "readwiseDeleteHighlight",
      "Elimina un highlight de Readwise.",
      { highlightId: z.union([z.number(), z.string()]).describe("ID del highlight") },
      async ({ highlightId }) => asText(readwiseDeleteHighlight(highlightId)),
    ),
    tool(
      "listVacaciones",
      "Consulta las vacaciones de Cal en Schedule CAL (Notion). Filtros opcionales: año (ej. '2025 - 2026'), status. Devuelve lista con nombre, fechas, días disponibles, país, presupuesto. Llamar cuando Cal pregunte por sus vacaciones, días disponibles, viajes planeados, o quiera revisar el plan de vacaciones.",
      {
        year: z.string().optional(),
        status: z.enum(["Not started", "In progress", "Done", "Canceled"]).optional(),
      },
      async (filters) => asText(listVacaciones(filters)),
      READ_ONLY,
    ),
    tool(
      "getVacacionDetail",
      "Obtiene detalle completo de una entrada de vacaciones: propiedades + BD interior (items de alojamiento, pasajes, actividades) + contenido de PDFs e imágenes adjuntos. SIEMPRE llamar después de listVacaciones cuando Cal pregunte por un viaje específico. El pageId aparece en el output de listVacaciones como [pageId: ...].",
      { pageId: z.string() },
      async ({ pageId }) => asText(await getVacacionDetail(pageId)),
      READ_ONLY,
    ),
    tool(
      "notionCli",
      "Llamada a la API de Notion vía ntn CLI (acceso principal a Notion). Args: { method: 'GET'|'POST'|'PATCH', path: '/v1/...', body? }. " +
      "**`body` va como OBJETO JSON, no como string.** Correcto: body: {page_size: 5}. Incorrecto: body: \"{\\\"page_size\\\": 5}\". " +
      "Ejemplos: query DB → POST '/v1/databases/{id}/query' body {page_size:5}; búsqueda → POST '/v1/search' body {query,page_size:5}; leer página → GET '/v1/pages/{id}'; actualizar props → PATCH '/v1/pages/{id}' body {properties:{...}}; crear página → POST '/v1/pages' body {parent:{database_id},properties:{...}}. notion-version 2022-06-28 automática. (DELETE no permitido — archivar páginas con PATCH {in_trash:true}.) " +
      "Para queries que pueden devolver MUCHAS filas (ej. la DB de KPIs), acotá desde el vuelo: usá `filter` por fecha y `filter_properties` en el query string, o si igual sale un persisted-output, filtralo con `consultarJson` en vez de leerlo entero. " +
      "Devuelve el JSON de Notion. Si da 403/vacío, la integración no tiene esa página compartida.",
      { method: z.enum(["GET", "POST", "PATCH"]), path: z.string(), body: z.any().optional() },
      async ({ method, path, body }) => asText(notionApi(method, path, body)),
    ),
    tool(
      "notionPageMarkdown",
      "Lee el CUERPO de una página de Notion como Markdown (vía ntn pages get). Args: { pageId }. Útil para leer contenido de páginas, no solo propiedades.",
      { pageId: z.string() },
      async ({ pageId }) => asText(notionPageMarkdown(pageId)),
      READ_ONLY,
    ),
    tool(
      "notionUpdateBody",
      "Reemplaza el CUERPO de una página de Notion con Markdown (vía ntn pages update). REEMPLAZA todo el body. Args: { pageId, markdown }.",
      { pageId: z.string(), markdown: z.string() },
      async ({ pageId, markdown }) => asText(notionUpdateBody(pageId, markdown)),
    ),
  ];
}
