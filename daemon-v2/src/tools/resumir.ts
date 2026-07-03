import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sendMessage, editMessage, sendChatAction } from "@cos/shared";
import { sanitizeForTelegram } from "../format.js";

// Resumidor universal para Jano. Reutiliza los MISMOS scripts standalone que el
// skill `resumir` (~/.claude/scripts/*), invocándolos con spawn(argv) — sin shell,
// sin Bash, sin riesgo de inyección. El daemon corre bajo launchd, así que para leer
// cookies de Safari usa ~/.claude/bin/node-fda (que debe tener Full Disk Access).

const HOME = homedir();
const NODE_FDA = `${HOME}/.claude/bin/node-fda`;
const SAFARI_FETCH = `${HOME}/.claude/scripts/safari-fetch.mjs`;
const AUDIO_TRANSCRIBE = `${HOME}/.claude/scripts/audio-transcribe.sh`;
const READWISE_SAVE = `${HOME}/.claude/scripts/readwise-save.sh`;
const CLAUDE_BIN = `${HOME}/.npm-global/bin/claude`;
const TIMEOUT_BIN = "/opt/homebrew/bin/timeout";
const PLAYWRIGHT_BROWSERS_PATH = `${HOME}/Library/Caches/ms-playwright`;

const FETCH_TIMEOUT_MS = 60_000;        // safari-fetch
const TRANSCRIBE_TIMEOUT_MS = 600_000;  // yt-dlp + whisper (hasta 10 min)
const SUMMARIZE_TIMEOUT_SEC = 360;       // subprocess claude — subido de 180s (2026-07-03):
                                          // transcripciones muy largas (streams/programas en
                                          // vivo de +1h) pueden tardar más de 3 min en resumirse
const TG_MAX = 4000;                    // límite seguro por mensaje Telegram
const PENDING_DIR = `${HOME}/.cos-agent`; // estado de propuestas pendientes (entre runs)

export interface ResumirDeps {
  botToken: string;
}

export interface ResumirArgs {
  source: string;
  instruction?: string;
}

export interface GuardarReadwiseArgs {
  tags?: string[];                              // reemplaza los tags del doc (lista final)
  removeHighlights?: number[];                  // índices 1-based a quitar
  retag?: Array<{ index: number; tag: string }>; // re-taggear highlights (índice 1-based)
  fullArticle?: boolean;                        // guardar el ARTÍCULO COMPLETO (Reader baja la URL) + tags, no el resumen
}

type Kind = "article" | "video" | "podcast" | "book";

interface PendingProposal {
  title: string;
  url: string;
  kind: Kind;
  html: string;
  tags: string[];
  highlights: Array<{ text: string; tag?: string }>;
  createdAt: number;
  fromPlaylist?: boolean; // si la propuesta vino del auto-resumidor de playlist → auto-avanzar al guardar/saltar
  fromStarred?: boolean;  // si vino del auto-resumidor de starred de Feedbin → al cerrar, des-estrellar + auto-avanzar
  feedbinId?: number;     // id de la entrada de Feedbin (para des-estrellar al guardar/saltar)
  videoId?: string;       // id del video de YouTube (para quitarlo de 'seen' al cancelar y dejarlo para después)
  messageId?: number;     // id del mensaje-tarjeta de la propuesta (para editarlo en su lugar: guardar/saltar/editar)
  placeholder?: boolean;  // lock: reserva el slot mientras run() transcribe/resume (anti-carrera)
  saving?: boolean;       // lock sincrónico: guardado en curso (anti doble-tap de ✅ Guardar)
}

// Opciones de origen para run(): de dónde viene el item y, si ya tenemos el texto, evita re-fetchearlo.
interface RunOpts {
  fromPlaylist?: boolean;
  fromStarred?: boolean;
  feedbinId?: number;
  videoId?: string;      // id del video de YouTube (playlist) → para rescatarlo de 'seen' si se cancela en curso
  prefetched?: { text: string; title: string; author?: string }; // texto ya obtenido (starred: contenido de Feedbin)
  anchorMsgId?: number;  // mensaje ancla a editar por fases (la cola lo crea; si falta, run() lo crea)
}

// Cancelación en curso: cuando Cal toca "⏹️ Parar" mientras el siguiente ítem se está
// resumiendo, runDetener marca el chatId acá; run() lo detecta en sus checkpoints y aborta
// el ítem en curso (lo deja para después). En memoria: el daemon es un único proceso.
const cancelRequested = new Set<number>();

// Ediciones sobre la propuesta pendiente SIN guardar (botones 🏷️ Agregar tag / ✏️ Editar).
export interface EditarPropuestaArgs {
  addTags?: string[];                            // agrega tags al doc (además de los existentes)
  setTags?: string[];                            // reemplaza por completo los tags del doc
  removeHighlights?: number[];                   // índices 1-based a quitar
  retag?: Array<{ index: number; tag: string }>; // re-taggear highlights (índice 1-based)
}

function pendingPath(chatId: number): string {
  return join(PENDING_DIR, `pending-resumir-${chatId}.json`);
}

// Limpia locks de propuesta huérfanos (placeholder:true) que quedaron de un run matado por un
// restart del daemon a mitad de transcripción/resumen. Sin esto, el resumidor queda pegado: el
// lock existe pero el proceso que lo iba a resolver murió. Llamar al arrancar el daemon.
export function cleanStalePlaceholders(): number {
  let cleaned = 0;
  try {
    for (const f of readdirSync(PENDING_DIR)) {
      if (!/^pending-resumir-.*\.json$/.test(f)) continue;
      const p = join(PENDING_DIR, f);
      const prop = readJsonSafe<PendingProposal | null>(p, null);
      if (prop && prop.placeholder) {
        try { unlinkSync(p); cleaned++; } catch { /* noop */ }
      }
    }
  } catch { /* PENDING_DIR no existe → nada que limpiar */ }
  return cleaned;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Trae los tags existentes de Reader para que el LLM los reutilice (no inventar de cero).
async function fetchReaderTags(): Promise<string[]> {
  const token = process.env.READWISE_TOKEN;
  if (!token) return [];
  const names: string[] = [];
  let cursor = "";
  const deadline = Date.now() + 20_000; // tope total — no demorar el resumen por traer tags
  try {
    for (let i = 0; i < 10 && Date.now() < deadline; i++) {
      const u = new URL("https://readwise.io/api/v3/tags/");
      if (cursor) u.searchParams.set("pageCursor", cursor);
      const res = await fetch(u, { headers: { Authorization: `Token ${token}` }, signal: AbortSignal.timeout(8_000) });
      if (!res.ok) break;
      const data = (await res.json()) as { results?: Array<{ name?: string; key?: string }>; nextPageCursor?: string };
      for (const t of data.results ?? []) { const n = t.name ?? t.key; if (n) names.push(n); }
      if (!data.nextPageCursor) break;
      cursor = data.nextPageCursor;
    }
  } catch { /* sin tags existentes → el LLM crea propios */ }
  return names;
}

function detectKind(src: string): Kind {
  const s = src.trim();
  if (!/^https?:\/\//i.test(s)) return "book"; // texto suelto = título de libro
  let host = "";
  try { host = new URL(s).hostname.replace(/^www\./, ""); } catch { return "article"; }
  if (host.endsWith("youtube.com") || host === "youtu.be") return "video";
  if (host.endsWith("spotify.com")) return "podcast";
  if (host.endsWith("podcasts.apple.com")) return "podcast";
  if (host.endsWith("overcast.fm")) return "podcast";
  if (/\.(mp3|m4a|wav|aac|ogg)(\?|$)/i.test(s)) return "podcast";
  return "article";
}

// Corre un comando, junta stdout y parsea la última línea como JSON.
function runJson(cmd: string, args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH },
    });
    if (!child.pid) { reject(new Error(`no se pudo arrancar ${cmd}`)); return; }
    child.unref();
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("timeout")); }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const lastLine = out.trim().split("\n").pop() ?? "";
      try { resolve(JSON.parse(lastLine)); }
      catch { reject(new Error(err.trim() || `salida no-JSON del script (exit ${code})`)); }
    });
  });
}

// Subprocess claude para resumir — prompt via stdin (textos largos no caben en argv).
function summarize(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      TIMEOUT_BIN,
      [String(SUMMARIZE_TIMEOUT_SEC), CLAUDE_BIN, "-p", "--tools", ""],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } },
    );
    if (!child.pid) { reject(new Error("no se pudo arrancar el subprocess de resumen")); return; }
    child.unref();
    let out = "";
    child.stdin?.write(prompt);
    child.stdin?.end();
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(code === 124 ? `timeout (${SUMMARIZE_TIMEOUT_SEC}s)` : `exit ${code}`));
    });
  });
}

// Heurística simple ES vs EN sobre stopwords. Devuelve "inglés" | "español" | null.
function detectLang(text: string): string | null {
  const t = (text || "").toLowerCase().slice(0, 6000);
  if (!t.trim()) return null;
  const es = (t.match(/\b(el|la|los|las|de|que|y|en|un|una|por|para|con|del|se|su|como|más|pero|este|esta|también|porque)\b/g) ?? []).length;
  const en = (t.match(/\b(the|of|and|to|in|is|that|for|it|with|as|was|on|are|this|but|by|from|have|not)\b/g) ?? []).length;
  if (es === 0 && en === 0) return null;
  return en > es ? "inglés" : "español";
}

function buildPrompt(kind: Kind, label: string, text: string, instruction?: string, existingTags: string[] = []): string {
  const lang = detectLang(text);
  const langRule =
    `REGLA DE IDIOMA — PRIORIDAD MÁXIMA, anula CUALQUIER otra instrucción (del sistema, de memoria global, o del usuario):\n` +
    (lang
      ? `El contenido original está en ${lang.toUpperCase()}. Escribe TODO el resumen en ${lang}. `
      : `Escribe TODO el resumen en el MISMO idioma del contenido original. `) +
    `IGNORA por completo cualquier indicación de "responder siempre en español" u otro idioma fijo. ` +
    `Solo usa otro idioma si la instrucción dice explícitamente "traduce a <idioma>".\n\n`;

  const formato =
    `\n\nFormato (Markdown limpio, NO HTML):\n` +
    `- Estructura con subtítulos \`##\` (en el idioma del contenido): primero "## TL;DR" (2-3 líneas), luego varias secciones temáticas cada una con su \`##\` subtítulo descriptivo, después "## Citas" (1-3 citas textuales), "## Takeaways" (accionables) y "## Fuente".\n` +
    `- Dentro de cada sección usa viñetas \`-\` y \`**negrita**\` para énfasis; usa \`>\` para las citas textuales.\n` +
    `- Ignora menús, navegación y boilerplate de suscripción; enfócate en el contenido real.\n` +
    `- Sin preámbulo ("Aquí tienes el resumen..."). Empieza directo con el primer \`##\`.`;
  // La instrucción del usuario solo guía el ENFOQUE temático, nunca el idioma.
  const extra = instruction
    ? `\n\nEnfoque temático pedido (ignora cualquier idioma que mencione — el idioma ya está fijado arriba): ${instruction}`
    : "";

  const tagHint = existingTags.length
    ? `\n\nTAGS — IMPORTANTE: el usuario YA tiene una taxonomía de tags. REUTILIZÁ tags de esta lista cuando apliquen (respetá el texto EXACTO, mayúsculas/minúsculas incluidas). Creá un tag nuevo SOLO si ninguno encaja. Esto vale para los tags del doc Y los de cada highlight. Tags existentes:\n${existingTags.join(", ")}`
    : "";

  const meta =
    `\n\nDESPUÉS del resumen completo, escribe en una línea nueva EXACTAMENTE el separador ===RESUMIR-META=== y debajo un ÚNICO objeto JSON (sin code fences, sin texto adicional) con esta forma:\n` +
    `{"title":"título corto y descriptivo del contenido, ≤80 chars, en el idioma del contenido (NO 'Resumen de...')","tags":["3-5 tags temáticos del contenido"],"highlights":[{"text":"cita textual o idea clave (literal del contenido cuando se pueda)","tag":"un-tag"}]}\n` +
    `Incluí entre 5 y 8 highlights, los MÁS importantes. Textos de highlights en el idioma del contenido. Nada después del JSON.` +
    tagHint;

  if (kind === "book") {
    return (
      langRule +
      `Resume el libro titulado "${label}" desde tu conocimiento, en el idioma original del libro. ` +
      `Si NO lo conoces con solidez, DILO claramente al inicio en una línea y no inventes contenido. ` +
      `Si lo conoces, marca al inicio "(desde mi conocimiento, no del texto original)".` +
      extra + formato + meta
    );
  }
  const tipo = kind === "video" ? "la transcripción de este video" : kind === "podcast" ? "la transcripción de este podcast/audio" : "este artículo";
  return (
    langRule +
    `Tienes ${tipo} de ${label}:\n\n` + text + `\n\n---\n` +
    `Genera un resumen del contenido.` + extra + formato + meta
  );
}

// Separa el output del subprocess en: resumen markdown + metadata (tags + highlights).
function splitMeta(raw: string): { md: string; title: string; tags: string[]; highlights: Array<{ text: string; tag?: string }> } {
  const SEP = "===RESUMIR-META===";
  const idx = raw.indexOf(SEP);
  if (idx === -1) return { md: raw.trim(), title: "", tags: [], highlights: [] };
  const md = raw.slice(0, idx).trim();
  const rest = raw.slice(idx + SEP.length).trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const m = rest.match(/\{[\s\S]*\}/);
  let title = "";
  let tags: string[] = [];
  let highlights: Array<{ text: string; tag?: string }> = [];
  if (m) {
    try {
      const parsed = JSON.parse(m[0]) as { title?: unknown; tags?: unknown; highlights?: unknown };
      if (typeof parsed.title === "string") title = parsed.title.trim();
      if (Array.isArray(parsed.tags)) {
        tags = parsed.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim());
      }
      if (Array.isArray(parsed.highlights)) {
        highlights = parsed.highlights
          .filter((h): h is { text: string; tag?: string } => !!h && typeof (h as { text?: unknown }).text === "string" && (h as { text: string }).text.trim() !== "")
          .map((h) => ({ text: String(h.text).trim(), tag: typeof h.tag === "string" ? h.tag.trim() : undefined }));
      }
    } catch { /* sin meta válida → seguir sin tags/highlights */ }
  }
  return { md, title, tags, highlights };
}

function deriveTitle(kind: Kind, source: string, text: string, explicitTitle: string, metaTitle: string): string {
  if (explicitTitle.trim()) return explicitTitle.trim().slice(0, 160);
  if (kind === "book") return source.slice(0, 140);
  if (kind === "article") {
    const first = text.split("\n").map((s) => s.trim()).find(Boolean);
    if (first) return first.slice(0, 140);
  }
  // Video/podcast sin título de la fuente (ej. podcast no-YouTube): el LLM propone uno en el meta,
  // mucho mejor que caer al hostname ("Resumen — overcast.fm").
  if (metaTitle.trim()) return metaTitle.trim().slice(0, 140);
  try { return `Resumen — ${new URL(source).hostname.replace(/^www\./, "")}`; } catch { return "Resumen"; }
}

// Guarda en Readwise: doc con tags temáticos + highlights tageados (reusa el script standalone). Best-effort.
// fullArticle: en vez de nuestro resumen, guarda el ARTÍCULO COMPLETO (Reader baja el original de la URL) + tags.
async function saveToReadwise(
  title: string,
  url: string,
  kind: Kind,
  html: string,
  tags: string[],
  highlights: Array<{ text: string; tag?: string }>,
  fullArticle = false,
): Promise<{ url?: string; highlights?: number } | null> {
  // Reader reconoce URLs de YouTube/podcast e IGNORA el HTML que mandamos: re-scrapea la
  // fuente y embebe el video + transcript completo en vez de nuestro resumen. Para media
  // usamos URL sintética (vacía → el script genera read.readwise.io/new/<slug>, mismo slug
  // para doc y highlights por el título → quedan ligados) y dejamos el link real al inicio
  // del cuerpo. Artículos conservan su URL real (no tienen este problema).
  const isMedia = kind === "video" || kind === "podcast";
  const articleMode = fullArticle && !!url; // Reader baja el original; requiere una URL real
  const docUrl = articleMode ? url : (isMedia ? "" : url);
  const finalHtml = (!articleMode && isMedia && url)
    ? `<p><strong>Fuente:</strong> <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>\n${html}`
    : html;
  const stamp = `${process.pid}-${Math.round(performance.now())}`;
  const htmlFile = join(tmpdir(), `resumir-${stamp}.html`);
  const hlFile = join(tmpdir(), `resumir-hl-${stamp}.json`);
  let hlArg = "";
  try {
    // htmlArg "-" = modo artículo (sin html → Reader baja la URL); si no, escribimos nuestro resumen.
    let htmlArg = "-";
    if (!articleMode) { writeFileSync(htmlFile, finalHtml, "utf8"); htmlArg = htmlFile; }
    const tagsCsv = tags.map((t) => t.replace(/,/g, " ").trim()).filter(Boolean).join(",");
    if (highlights.length) { writeFileSync(hlFile, JSON.stringify(highlights), "utf8"); hlArg = hlFile; }
    const r = await runJson(READWISE_SAVE, [title || "Resumen", "", docUrl, "article", htmlArg, tagsCsv, hlArg], 60_000);
    return { url: typeof r.url === "string" ? r.url : undefined, highlights: typeof r.highlights === "number" ? r.highlights : 0 };
  } catch {
    return null;
  } finally {
    if (!articleMode) { try { unlinkSync(htmlFile); } catch { /* noop */ } }
    if (hlArg) { try { unlinkSync(hlFile); } catch { /* noop */ } }
  }
}

// Tarjeta de propuesta (checkpoint) con botones inline. Edit-in-place: el mismo mensaje pasa de
// tarjeta → "Guardando" → "Guardado"/"Descartado". Highlights truncados solo para mostrar (a
// Readwise va el texto completo de proposal.highlights).
// Para artículos se ofrece además "📄 Guardar artículo" (Reader baja el original con los tags).
function buildCardKeyboard(kind: Kind): unknown {
  const saveRow = kind === "article"
    ? [
        { text: "✅ Guardar resumen", callback_data: "j:resu:save" },
        { text: "📄 Guardar artículo", callback_data: "j:resu:savefull" },
      ]
    : [
        { text: "✅ Guardar", callback_data: "j:resu:save" },
        { text: "🏷️ Agregar tag", callback_data: "j:resu:tag" },
      ];
  const secondRow = kind === "article"
    ? [
        { text: "🏷️ Agregar tag", callback_data: "j:resu:tag" },
        { text: "✏️ Editar", callback_data: "j:resu:edit" },
      ]
    : [
        { text: "✏️ Editar", callback_data: "j:resu:edit" },
        { text: "⏭️ Saltar", callback_data: "j:resu:skip" },
      ];
  const lastRow = kind === "article"
    ? [
        { text: "⏭️ Saltar", callback_data: "j:resu:skip" },
        { text: "⏹️ Parar", callback_data: "j:resu:stop" },
      ]
    : [
        { text: "⏹️ Parar la cola", callback_data: "j:resu:stop" },
      ];
  return { inline_keyboard: [saveRow, secondRow, lastRow] };
}

// Mini-teclado de un solo botón para los mensajes de progreso del siguiente ítem de la cola.
// Telegram quita el reply_markup en cada edición sin teclado, así que se re-pasa en cada fase.
function stopKeyboard(): unknown {
  return { inline_keyboard: [[{ text: "⏹️ Parar la cola", callback_data: "j:resu:stop" }]] };
}

function buildProposalCard(proposal: PendingProposal): { text: string; keyboard: unknown } {
  const tags = proposal.tags ?? [];
  const highlights = proposal.highlights ?? [];
  const tagLine = tags.length ? tags.map((t) => `🏷️ ${escapeHtml(t)}`).join("  ") : "(ninguno)";
  const hls = highlights.length
    ? highlights.map((h, i) => `${i + 1}. ${escapeHtml(h.text.slice(0, 220))}${h.tag ? `  🏷️ <i>${escapeHtml(h.tag)}</i>` : ""}`).join("\n\n")
    : "(ninguno)";
  const title = proposal.title ? `\n<i>${escapeHtml(proposal.title.slice(0, 120))}</i>` : "";
  const text =
    `📋 <b>Revisá antes de guardar en Readwise</b>${title}\n\n` +
    `<b>Tags del documento:</b>\n${tagLine}\n\n` +
    `<b>Highlights (${highlights.length}):</b>\n\n${hls}`;
  return { text, keyboard: buildCardKeyboard(proposal.kind) };
}

// Edita un mensaje existente (la tarjeta); si no hay messageId o el edit falla, manda uno nuevo.
async function setCardMessage(botToken: string, chatId: number, messageId: number | undefined, text: string, keyboard?: unknown): Promise<number | undefined> {
  if (messageId != null) {
    const ok = await editMessage(botToken, chatId, messageId, text, "HTML", keyboard).then(() => true).catch(() => false);
    if (ok) return messageId;
  }
  const sent = await sendMessage(botToken, { chatId, text, parseMode: "HTML", replyMarkup: keyboard }).catch(() => null);
  return sent?.message_id;
}

// Markdown → HTML de Telegram: headings a <b>, citas a <blockquote>, resto vía sanitizeForTelegram.
// Garantiza una línea en blanco antes/después de cada subtítulo y entre citas (más limpio).
function mdToTelegram(md: string): string {
  let s = md.replace(/\r/g, "");
  s = s.replace(/^#{1,6}\s+(.*)$/gm, "\n<b>$1</b>\n");           // subtítulo con aire alrededor
  s = s.replace(/^>\s?(.*)$/gm, "\n<blockquote>$1</blockquote>\n"); // citas separadas
  s = sanitizeForTelegram(s); // **→<b>, *→<i>, - →•, colapsa 3+ saltos a 2, trim
  return s;
}

// Markdown → HTML estructurado para Readwise Reader (headings, listas, citas, énfasis).
function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<![*\w])\*([^*]+)\*(?![*\w])/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');

  const out: string[] = [];
  let para: string[] = [];
  let inList = false;
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  const flushList = () => { if (inList) { out.push("</ul>"); inList = false; } };

  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (h) { flushPara(); flushList(); const lvl = Math.min(h[1].length, 4); out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); continue; }
    if (bullet) { flushPara(); if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${inline(bullet[1])}</li>`); continue; }
    if (quote) { flushPara(); flushList(); out.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join("\n");
}

// Emoji de autor/fuente según tipo de documento — antepuesto junto al título en el resumen.
const AUTHOR_EMOJI: Record<Kind, string> = {
  video: "🎬",
  podcast: "🎬",
  article: "📰",
  book: "📰",
};

// Arma las 1-2 líneas de título + autor/canal a anteponer al TL;DR del resumen entregado.
// Pura y testeable: sin I/O. Si no hay ni título ni autor, devuelve string vacío (no agrega nada).
export function buildResumenHeader(title: string | undefined, author: string | undefined, kind: Kind): string {
  const t = (title ?? "").trim();
  const a = (author ?? "").trim();
  if (!t && !a) return "";
  const titleLine = t ? `<b>${escapeHtml(t)}</b>` : "";
  const authorLine = a ? `${AUTHOR_EMOJI[kind]} ${escapeHtml(a)}` : "";
  return [titleLine, authorLine].filter(Boolean).join("\n") + "\n\n";
}

function chunk(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const parts: string[] = [];
  let cur = "";
  for (const line of s.split("\n")) {
    if ((cur ? cur.length + 1 : 0) + line.length > max) {
      if (cur) { parts.push(cur); cur = ""; }
      while (line.length > max) { parts.push(line.slice(0, max)); cur = ""; }
      cur = line.length > max ? "" : line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

async function run(deps: ResumirDeps, chatId: number, kind: Kind, args: ResumirArgs, opts: RunOpts = {}): Promise<void> {
  const { botToken } = deps;
  const typing = () => sendChatAction(botToken, chatId, "typing").catch(() => {});
  let anchorId = opts.anchorMsgId;
  // Un solo mensaje ancla editado por fases (en vez de varios mensajes sueltos). Si no hay, lo crea.
  const setAnchor = async (text: string, keyboard?: unknown): Promise<void> => {
    anchorId = await setCardMessage(botToken, chatId, anchorId, text, keyboard);
  };
  // Ítems que vienen de una cola: llevan el botón "⏹️ Parar la cola" en cada fase de progreso,
  // para poder frenar sin esperar a que termine de resumirse el siguiente.
  const fromQueue = !!(opts.fromPlaylist || opts.fromStarred);
  const progressKb = fromQueue ? stopKeyboard() : undefined;
  // Aborta el ítem en curso si Cal tocó "⏹️ Parar" mientras se procesaba: borra el lock, lo saca
  // de 'seen' (para que reaparezca al "revisar"), NO lo des-estrella / NO lo saca de la playlist.
  const bailIfCancelled = async (): Promise<boolean> => {
    if (!fromQueue || !cancelRequested.has(chatId)) return false;
    cancelRequested.delete(chatId);
    try { unlinkSync(pendingPath(chatId)); } catch { /* noop */ }
    if (opts.fromStarred && opts.feedbinId != null) {
      const seen = new Set(readJsonSafe<{ ids: number[] }>(STARRED_SEEN, { ids: [] }).ids);
      seen.delete(opts.feedbinId);
      writeJsonSafe(STARRED_SEEN, { ids: [...seen] });
    }
    if (opts.fromPlaylist && opts.videoId) {
      const seen = new Set(readJsonSafe<{ ids: string[] }>(PLAYLIST_SEEN, { ids: [] }).ids);
      seen.delete(opts.videoId);
      writeJsonSafe(PLAYLIST_SEEN, { ids: [...seen] });
    }
    await setAnchor('⏹️ <b>Cancelado</b> — lo dejé para después. Decí "revisa la playlist" o "revisa starred" para retomarlo.');
    return true;
  };
  // NO se limpia el flag acá: si Cal tocó ⏹️ durante el "Procesando..." previo a entrar a run(),
  // borrarlo mataría esa cancelación legítima. El reset del flag viejo lo hace advance*Queue al
  // ARRANCAR cada ítem de cola (punto único), de modo que aquí el flag refleja solo este ítem.
  let text = "";
  let docTitle = "";
  let docAuthor = "";

  await typing();
  if (opts.prefetched) {
    // El contenido ya viene resuelto (ej. starred de Feedbin: contenido extraído por Feedbin).
    text = opts.prefetched.text;
    if (opts.prefetched.title.trim()) docTitle = opts.prefetched.title.trim();
    if (opts.prefetched.author?.trim()) docAuthor = opts.prefetched.author.trim();
    await setAnchor("💭 Resumiendo...", progressKb);
  } else if (kind === "article") {
    await setAnchor("📥 Leyendo el artículo...", progressKb);
    const r = await runJson(NODE_FDA, [SAFARI_FETCH, args.source], FETCH_TIMEOUT_MS);
    if (r.status === "needs-fda") {
      await setAnchor("🔒 No puedo leer las cookies de Safari. Otorgá Full Disk Access a <code>~/.claude/bin/node-fda</code> en Ajustes → Privacidad y seguridad → Acceso completo al disco, y reintentá.");
      return;
    }
    if (r.status === "needs-login") {
      await setAnchor("🔒 Ese artículo está tras un muro y no detecté sesión. Iniciá sesión en ese sitio en Safari y reintentá.");
      return;
    }
    if (r.status !== "ok" || typeof r.text !== "string" || !r.text) {
      await setAnchor(`❌ No pude obtener el artículo (${String(r.status ?? "error")}).`);
      return;
    }
    text = r.text;
    if (typeof r.title === "string") docTitle = r.title;
    await setAnchor("💭 Resumiendo...", progressKb);
  } else if (kind === "video" || kind === "podcast") {
    await setAnchor(kind === "video" ? "🎬 Transcribiendo el video..." : "🎧 Transcribiendo el audio...", progressKb);
    await typing();
    const r = await runJson(AUDIO_TRANSCRIBE, [args.source], TRANSCRIBE_TIMEOUT_MS);
    if (r.status === "spotify-drm") {
      await setAnchor("🚫 Spotify no deja descargar el audio (DRM). Pasame el episodio en YouTube/Apple Podcasts o un link directo/RSS.");
      return;
    }
    if (r.status !== "ok" || typeof r.transcript !== "string" || !r.transcript) {
      await setAnchor(`❌ No pude transcribir (${String(r.status ?? "error")}).`);
      return;
    }
    text = r.transcript;
    if (typeof r.title === "string" && r.title.trim()) docTitle = r.title.trim();
    if (typeof r.channel === "string" && r.channel.trim()) docAuthor = r.channel.trim();
    await setAnchor("💭 Resumiendo...", progressKb);
  } else {
    await setAnchor("📚 Resumiendo el libro desde mi conocimiento...");
  }

  // ¿Cal pidió parar mientras buscábamos el contenido? Abortar antes del resumen (lo caro, ~180s).
  if (await bailIfCancelled()) return;

  await typing();
  const existingTags = await fetchReaderTags();
  const raw = await summarize(buildPrompt(kind, args.source, text, args.instruction, existingTags));
  const { md, title: metaTitle, tags, highlights } = splitMeta(raw);

  // ¿Cal pidió parar mientras resumíamos? Abortar antes de mostrar la tarjeta de propuesta.
  if (await bailIfCancelled()) return;

  // Entrega del resumen: el primer chunk EDITA el ancla; los chunks extra van como mensajes nuevos.
  const header = buildResumenHeader(docTitle, docAuthor, kind);
  const parts = chunk(header + mdToTelegram(md), TG_MAX);
  await setAnchor(parts[0] ?? "(resumen vacío)");
  for (const extra of parts.slice(1)) {
    const sent = await sendMessage(botToken, { chatId, text: extra, parseMode: "HTML" }).catch(() => null);
    if (!sent) await sendMessage(botToken, { chatId, text: extra }).catch(() => {});
  }

  // Checkpoint: tarjeta de propuesta con botones (mensaje nuevo). NO escribe a Readwise hasta confirmar.
  const proposal: PendingProposal = {
    title: deriveTitle(kind, args.source, text, docTitle, metaTitle),
    url: /^https?:\/\//i.test(args.source) ? args.source : "",
    kind,
    html: mdToHtml(md),
    tags,
    highlights,
    createdAt: Date.now(),
    fromPlaylist: opts.fromPlaylist,
    fromStarred: opts.fromStarred,
    feedbinId: opts.feedbinId,
  };
  const card = buildProposalCard(proposal);
  const cardSent = await sendMessage(botToken, { chatId, text: card.text, parseMode: "HTML", replyMarkup: card.keyboard }).catch(() => null);
  proposal.messageId = cardSent?.message_id;
  try { writeFileSync(pendingPath(chatId), JSON.stringify(proposal), "utf8"); }
  catch { /* si no se puede persistir, igual mostramos la propuesta */ }
}

async function runGuardar(deps: ResumirDeps, chatId: number, args: GuardarReadwiseArgs): Promise<void> {
  const { botToken } = deps;
  const tg = (text: string) => sendMessage(botToken, { chatId, text, parseMode: "HTML" }).catch(() => {});
  const p = pendingPath(chatId);
  let proposal: PendingProposal;
  if (!existsSync(p)) {
    await tg("No hay ningún resumen pendiente de guardar. Mandame primero un link o título para resumir.");
    return;
  }
  try {
    proposal = JSON.parse(readFileSync(p, "utf8")) as PendingProposal;
  } catch {
    await tg("No pude leer la propuesta pendiente. Reenviá el link para regenerarla.");
    return;
  }
  if (proposal && proposal.placeholder) {
    await tg("⏳ Ese video todavía se está procesando. Esperá a que llegue el resumen y después decime 'guardar'.");
    return;
  }
  if (!proposal || typeof proposal.html !== "string" || !Array.isArray(proposal.highlights) || !Array.isArray(proposal.tags)) {
    await tg("La propuesta pendiente está incompleta o es de una versión anterior. Reenviá el link para regenerarla.");
    try { unlinkSync(p); } catch { /* noop */ }
    return;
  }
  // Anti doble-tap de ✅ Guardar: lock sincrónico (read+set+write sin await → atómico en el event
  // loop) ANTES del await de saveToReadwise, que tarda segundos. Un 2º tap ve saving:true y sale.
  if (proposal.saving) return;
  proposal.saving = true;
  try { writeFileSync(p, JSON.stringify(proposal), "utf8"); } catch { /* noop */ }

  // Aplicar ediciones de Cal sobre la propuesta.
  const tags = Array.isArray(args.tags)
    ? args.tags.filter((t) => typeof t === "string" && t.trim() !== "").map((t) => t.trim())
    : proposal.tags;
  let highlights = proposal.highlights.slice();
  if (Array.isArray(args.retag)) {
    for (const r of args.retag) {
      const i = r.index - 1;
      if (i >= 0 && i < highlights.length && typeof r.tag === "string" && r.tag.trim()) {
        highlights[i] = { ...highlights[i], tag: r.tag.trim() };
      }
    }
  }
  if (Array.isArray(args.removeHighlights) && args.removeHighlights.length) {
    const drop = new Set(args.removeHighlights.map((n) => n - 1));
    highlights = highlights.filter((_, i) => !drop.has(i));
  }

  const full = !!args.fullArticle;
  const cardId = proposal.messageId;
  await setCardMessage(botToken, chatId, cardId, full ? "⏳ Guardando el artículo completo en Readwise..." : "⏳ Guardando en Readwise..."); // quita los botones mientras guarda
  const rw = await saveToReadwise(proposal.title, proposal.url, proposal.kind, proposal.html, tags, highlights, full);
  if (rw?.url) {
    try { unlinkSync(p); } catch { /* noop */ }
    const hl = rw.highlights ? ` · ${rw.highlights} highlights` : "";
    const note = await cleanupProcessedSource(proposal); // esperar el cleanup → no se cuela en el item siguiente
    const label = full ? "📄 <b>Artículo guardado en Readwise</b>" : "📚 <b>Guardado en Readwise</b>";
    await setCardMessage(botToken, chatId, cardId, `${label}${hl}${note}\n${escapeHtml(rw.url)}`);
    await maybeAdvance(deps, chatId);
  } else {
    // Falló: liberar el lock (para poder reintentar) y volver a mostrar la tarjeta con botones.
    proposal.saving = false;
    try { writeFileSync(p, JSON.stringify(proposal), "utf8"); } catch { /* noop */ }
    const card = buildProposalCard({ ...proposal, tags, highlights });
    await setCardMessage(botToken, chatId, cardId, `${card.text}\n\n❌ No pude guardar, reintentá.`, card.keyboard);
  }
}

export function resumirContenido(
  deps: ResumirDeps,
  chatId: number,
  args: ResumirArgs,
): { status: string; message: string } {
  const kind = detectKind(args.source);
  // Fire-and-forget: el daemon es de larga vida; el pipeline corre en background.
  void run(deps, chatId, kind, args).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    void sendMessage(deps.botToken, {
      chatId,
      text: `❌ Error resumiendo (${msg}). Intentá de nuevo.`,
      parseMode: "HTML",
    }).catch(() => {});
  });

  const kindEs = { article: "artículo", video: "video", podcast: "podcast", book: "libro" }[kind];
  return {
    status: "started",
    message:
      `Procesando ${kindEs} en background; el resumen + una propuesta de tags/highlights le llegan a Cal en ~1-3 min como mensajes nuevos. ` +
      `Ahora solo confirmá a Cal en UNA línea que estás procesando. ` +
      `ACCIÓN REQUERIDA (para vos, el asistente) EN EL PRÓXIMO TURNO: si el siguiente mensaje de Cal es "guardar"/"guárdalo"/"ok"/"dale"/"sí"/"archívalo" o pide cambios a tags/highlights, DEBÉS llamar la tool guardarResumenReadwise (sin args = guardar tal cual; o tags/removeHighlights/retag para ediciones). NO respondas con texto en ese caso — llamá la tool (lee la propuesta pendiente de disco sola).`,
  };
}

// Paso 2 del checkpoint: guarda en Readwise la propuesta pendiente (tras confirmación/ediciones de Cal).
export function guardarResumenReadwise(
  deps: ResumirDeps,
  chatId: number,
  args: GuardarReadwiseArgs,
): { status: string; message: string } {
  void runGuardar(deps, chatId, args).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    void sendMessage(deps.botToken, {
      chatId,
      text: `❌ Error guardando en Readwise (${msg}).`,
      parseMode: "HTML",
    }).catch(() => {});
  });
  return { status: "started", message: "Guardado iniciado: YA edito la tarjeta en Telegram (⏳ Guardando → 📚 Guardado) y avanzo la cola solo. NO escribas ningún texto de respuesta — devolvé VACÍO." };
}

// Edita la propuesta pendiente (tags/highlights) SIN guardar y re-renderiza la tarjeta en su lugar.
async function runEditar(deps: ResumirDeps, chatId: number, args: EditarPropuestaArgs): Promise<void> {
  const { botToken } = deps;
  const p = pendingPath(chatId);
  if (!existsSync(p)) {
    await sendMessage(botToken, { chatId, text: "No hay ninguna propuesta pendiente para editar. Mandame un link o título para resumir.", parseMode: "HTML" }).catch(() => {});
    return;
  }
  const proposal = readJsonSafe<PendingProposal | null>(p, null);
  if (!proposal || proposal.placeholder || proposal.saving || !Array.isArray(proposal.tags) || !Array.isArray(proposal.highlights)) {
    await sendMessage(botToken, { chatId, text: "⏳ El resumen se está procesando o guardando; esperá un momento.", parseMode: "HTML" }).catch(() => {});
    return;
  }
  if (Array.isArray(args.setTags)) {
    proposal.tags = args.setTags.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim());
  }
  if (Array.isArray(args.addTags) && args.addTags.length) {
    const existing = new Set(proposal.tags.map((t) => t.toLowerCase()));
    for (const t of args.addTags) {
      const tag = typeof t === "string" ? t.trim() : "";
      if (tag && !existing.has(tag.toLowerCase())) { proposal.tags.push(tag); existing.add(tag.toLowerCase()); }
    }
  }
  if (Array.isArray(args.retag)) {
    for (const r of args.retag) {
      const i = r.index - 1;
      if (i >= 0 && i < proposal.highlights.length && typeof r.tag === "string" && r.tag.trim()) {
        proposal.highlights[i] = { ...proposal.highlights[i], tag: r.tag.trim() };
      }
    }
  }
  if (Array.isArray(args.removeHighlights) && args.removeHighlights.length) {
    const drop = new Set(args.removeHighlights.map((n) => n - 1));
    proposal.highlights = proposal.highlights.filter((_, i) => !drop.has(i));
  }
  // Re-renderizar la tarjeta (con botones) en su lugar y persistir.
  const card = buildProposalCard(proposal);
  proposal.messageId = await setCardMessage(botToken, chatId, proposal.messageId, card.text, card.keyboard);
  try { writeFileSync(p, JSON.stringify(proposal), "utf8"); } catch { /* noop */ }
}

// Paso intermedio del checkpoint: aplica ediciones (agregar tag, quitar/retaggear highlight) SIN guardar.
export function editarPropuestaResumen(deps: ResumirDeps, chatId: number, args: EditarPropuestaArgs): { status: string; message: string } {
  void runEditar(deps, chatId, args).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    void sendMessage(deps.botToken, { chatId, text: `❌ Error editando la propuesta (${msg}).`, parseMode: "HTML" }).catch(() => {});
  });
  return { status: "started", message: "YA actualicé la tarjeta en Telegram con los cambios (sin guardar en Readwise). NO escribas texto de respuesta — devolvé VACÍO; Cal confirma con el botón ✅ Guardar." };
}

// ───────────────────────── Auto-resumidor de playlist de YouTube ─────────────────────────

const YTDLP = "/opt/homebrew/bin/yt-dlp";
const PLAYLIST_CONFIG = `${PENDING_DIR}/resumir-playlists.json`;
const PLAYLIST_SEEN = `${PENDING_DIR}/resumir-playlist-seen.json`;
const PLAYLIST_QUEUE = `${PENDING_DIR}/resumir-playlist-queue.json`;

// Feedbin starred: misma mecánica que la playlist (seen-set + cola), comparten el slot de propuesta.
const FEEDBIN_BASE = "https://api.feedbin.com/v2";
const STARRED_SEEN = `${PENDING_DIR}/resumir-starred-seen.json`;
const STARRED_QUEUE = `${PENDING_DIR}/resumir-starred-queue.json`;

interface PlaylistVideo { id: string; title: string; url: string }
interface StarredItem { id: number; title: string; url: string } // id = entry id de Feedbin

// Selector de cola: antes de arrancar a procesar de a uno, muestra conteo + lista numerada +
// botones para que Cal elija cuál resumir (o "Procesar todos" para el auto-avance FIFO de
// siempre). Pura y testeable: sin I/O. Mismo patrón que reviewMeetings (agent-tools.ts:770-834)
// — botones msel:{id} en filas de máx 5 + fila final. Acá: resu-pick:{kind}:{id}, más
// resu-pick:{kind}:all / resu-pick:{kind}:none.
export function buildQueueSelector(kind: "v" | "s", items: Array<{ id: string | number; title: string }>): { text: string; keyboard: unknown } {
  const emoji = kind === "v" ? "🎬" : "⭐";
  const noun = kind === "v" ? "video(s) nuevo(s) en la playlist" : "starred nuevo(s) en Feedbin";
  const lines = items.map((it, i) => `${i + 1}. ${escapeHtml(it.title.slice(0, 80))}`);
  const text = [
    `${emoji} <b>${items.length} ${noun}</b>`,
    "",
    lines.join("\n"),
    "",
    "¿Cuál querés que resuma?",
  ].join("\n");

  type TgButton = { text: string; callback_data: string };
  const numButtons: TgButton[] = items.map((it, i) => ({ text: `${i + 1}`, callback_data: `resu-pick:${kind}:${it.id}` }));
  const rows: TgButton[][] = [];
  for (let i = 0; i < numButtons.length; i += 5) rows.push(numButtons.slice(i, i + 5));
  rows.push([
    { text: "✅ Procesar todos", callback_data: `resu-pick:${kind}:all` },
    { text: "❌ Ahora no", callback_data: `resu-pick:${kind}:none` },
  ]);
  return { text, keyboard: { inline_keyboard: rows } };
}

function readJsonSafe<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}
function writeJsonSafe(path: string, obj: unknown): void {
  try { writeFileSync(path, JSON.stringify(obj), "utf8"); } catch { /* noop */ }
}

// ───────── Borrado del video de la playlist de YouTube (YouTube Data API v3) ─────────
// Tras procesar un video (guardar o saltar) lo sacamos de la playlist "para resumir", que
// funciona como inbox. Requiere OAuth con scope youtube (client_id/secret/refresh_token en
// env). Best-effort: si faltan credenciales o falla, el video igual quedó marcado como 'seen'.

function extractVideoId(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
    const v = u.searchParams.get("v");
    if (v) return v;
  } catch { /* noop */ }
  return "";
}

function extractPlaylistId(url: string): string {
  try { return new URL(url).searchParams.get("list") ?? ""; } catch { return ""; }
}

// refresh_token → access_token (Google OAuth), cacheado en memoria (~1h) para no refrescar
// en cada video de una ráfaga de playlist. Margen de 60s antes del vencimiento real.
let ytTokenCache: { token: string; expiresAt: number } | null = null;
async function ytAccessToken(): Promise<string> {
  if (ytTokenCache && Date.now() < ytTokenCache.expiresAt) return ytTokenCache.token;
  const body = new URLSearchParams({
    client_id: process.env.YOUTUBE_OAUTH_CLIENT_ID ?? "",
    client_secret: process.env.YOUTUBE_OAUTH_CLIENT_SECRET ?? "",
    refresh_token: process.env.YOUTUBE_OAUTH_REFRESH_TOKEN ?? "",
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const d = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!d.access_token) throw new Error("sin access_token");
  ytTokenCache = { token: d.access_token, expiresAt: Date.now() + ((d.expires_in ?? 3600) - 60) * 1000 };
  return d.access_token;
}

// Devuelve true si sacó el video de alguna playlist. NO manda mensaje (el caller lo refleja en la tarjeta).
async function removeVideoFromPlaylist(videoUrl: string): Promise<boolean> {
  if (!process.env.YOUTUBE_OAUTH_CLIENT_ID || !process.env.YOUTUBE_OAUTH_CLIENT_SECRET || !process.env.YOUTUBE_OAUTH_REFRESH_TOKEN) return false;
  const videoId = extractVideoId(videoUrl);
  if (!videoId) return false;
  const cfg = readJsonSafe<{ playlists?: string[] }>(PLAYLIST_CONFIG, {});
  const playlistIds = (cfg.playlists ?? []).map(extractPlaylistId).filter(Boolean);
  if (!playlistIds.length) return false;
  try {
    const auth = { Authorization: `Bearer ${await ytAccessToken()}` };
    let removed = false;
    for (const playlistId of playlistIds) {
      // playlistItems.list con videoId+playlistId → solo el ítem de ESE video en ESA playlist.
      const lu = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
      lu.searchParams.set("part", "id");
      lu.searchParams.set("playlistId", playlistId);
      lu.searchParams.set("videoId", videoId);
      lu.searchParams.set("maxResults", "50");
      const lr = await fetch(lu, { headers: auth, signal: AbortSignal.timeout(15_000) });
      if (!lr.ok) {
        // 401/403 (token sin scope youtube o credenciales malas) se vería igual que "no estaba
        // en la playlist" sin esto. Logueamos para que un error de setup sea diagnosticable.
        console.error(`[resumir] playlistItems.list ${lr.status} (videoId=${videoId}, playlist=${playlistId}): ${(await lr.text().catch(() => "")).slice(0, 200)}`);
        continue;
      }
      const ld = (await lr.json()) as { items?: Array<{ id?: string }> };
      for (const it of ld.items ?? []) {
        if (!it.id) continue;
        const du = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
        du.searchParams.set("id", it.id);
        const dr = await fetch(du, { method: "DELETE", headers: auth, signal: AbortSignal.timeout(15_000) });
        if (dr.ok || dr.status === 204) removed = true;
        else console.error(`[resumir] playlistItems.delete ${dr.status} (item=${it.id}): ${(await dr.text().catch(() => "")).slice(0, 200)}`);
      }
    }
    return removed;
  } catch (e) {
    // best-effort: el video ya quedó marcado como 'seen', no se reprocesa. Logueamos el motivo.
    console.error(`[resumir] removeVideoFromPlaylist falló (videoId=${videoId}): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ───────────────────── Auto-resumidor de starred de Feedbin ─────────────────────
// Espejo del flujo de playlist: revisa los starred, encola los nuevos (seen-set propio) y los
// propone de a uno con el mismo checkpoint. El texto sale del contenido que Feedbin ya tiene
// (sin Safari/FDA). Al guardar O saltar, se des-estrella la entrada (= sacarla de la "lista").

function feedbinAuth(): string | null {
  const u = process.env.FEEDBIN_USERNAME, p = process.env.FEEDBIN_PASSWORD;
  if (!u || !p) return null;
  return "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
}

// HTML → texto plano para el resumidor (los entries de Feedbin vienen en HTML).
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function feedbinGet(path: string): Promise<unknown | null> {
  const auth = feedbinAuth();
  if (!auth) return null;
  try {
    const r = await fetch(`${FEEDBIN_BASE}${path}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) { console.error(`[resumir] Feedbin GET ${path} → ${r.status}`); return null; }
    return await r.json();
  } catch (e) {
    console.error(`[resumir] Feedbin GET ${path} falló: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// Lista los starred (ids → metadata mínima) para encolar.
async function fetchStarredEntries(): Promise<StarredItem[]> {
  const ids = (await feedbinGet("/starred_entries.json")) as number[] | null;
  if (!ids || ids.length === 0) return [];
  const items: StarredItem[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const part = (await feedbinGet(`/entries.json?ids=${chunk.join(",")}&per_page=100`)) as Array<{ id: number; title: string | null; url: string }> | null;
    for (const e of part ?? []) items.push({ id: e.id, title: (e.title ?? e.url ?? "").trim() || `Entrada ${e.id}`, url: e.url ?? "" });
  }
  return items;
}

// Trae el contenido de un starred para resumir. Primero el content de Feedbin; si viene TRUNCADO
// (excerpt), baja el artículo completo con safari-fetch (full + atraviesa paywall vía cookies de
// Safari — mejor que el content del feed y que Mercury, que no pasa paywalls).
async function fetchStarredContent(entryId: number, url?: string): Promise<{ text: string; title: string; author?: string } | null> {
  const d = (await feedbinGet(`/entries/${entryId}.json`)) as { title?: string | null; content?: string | null; summary?: string | null; author?: string | null } | null;
  let text = d ? stripHtml(d.content ?? d.summary ?? "") : "";
  let title = (d?.title ?? "").trim();
  const author = (d?.author ?? "").trim();
  const TRUNCATED = 1500; // bajo este largo asumimos excerpt → intentar full vía safari-fetch
  if (url && /^https?:\/\//i.test(url) && text.length < TRUNCATED) {
    try {
      const r = await runJson(NODE_FDA, [SAFARI_FETCH, url], FETCH_TIMEOUT_MS);
      if (r.status === "ok" && typeof r.text === "string" && r.text.trim().length > text.length) {
        text = r.text;
        if (typeof r.title === "string" && r.title.trim()) title = r.title.trim();
      }
    } catch { /* fallback falló → quedarse con el content del feed */ }
  }
  if (!text.trim()) return null;
  return { text, title, author: author || undefined };
}

async function unstarFeedbinEntry(entryId: number): Promise<boolean> {
  const auth = feedbinAuth();
  if (!auth) return false;
  try {
    const r = await fetch(`${FEEDBIN_BASE}/starred_entries.json`, {
      method: "DELETE",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ starred_entries: [entryId] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok || r.status === 204) return true;
    console.error(`[resumir] unstar ${entryId} → ${r.status}`);
    return false;
  } catch (e) {
    console.error(`[resumir] unstar ${entryId} falló: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// Arranca a procesar UN starred ya elegido (reserva el lock, edita el ancla, corre run(), y si
// falla limpia + des-estrella + avanza al siguiente). Compartida entre el camino FIFO (shift(),
// modo batch) y el camino "por id" (splice desde resu-pick:s:{id}) — ver pickStarredItem.
async function startStarredItem(deps: ResumirDeps, chatId: number, item: StarredItem, anchorMsgId: number | undefined, autoAdvanceOnFail: boolean): Promise<void> {
  // Punto único de reset del flag de cancelación: cada ítem arranca limpio, sea elegido desde el
  // selector o por FIFO automático. Una parada vieja (de un ítem ya resuelto) no debe abortar este.
  cancelRequested.delete(chatId);
  // Lock sincrónico: reserva el slot antes de obtener contenido/resumir (anti-carrera).
  writeJsonSafe(pendingPath(chatId), { title: item.title, url: item.url, kind: "article", html: "", tags: [], highlights: [], createdAt: Date.now(), fromStarred: true, feedbinId: item.id, placeholder: true } satisfies PendingProposal);
  // Ancla: reusa el mensaje del tap (edición) o crea uno nuevo. run() lo sigue editando por fases.
  const anchor = await setCardMessage(deps.botToken, chatId, anchorMsgId, `⭐ <b>${escapeHtml(item.title)}</b>\n⏳ Procesando...`, stopKeyboard());
  let failed = false;
  try {
    const content = await fetchStarredContent(item.id, item.url);
    if (!content) failed = true;
    else await run(deps, chatId, "article", { source: item.url }, { fromStarred: true, feedbinId: item.id, prefetched: content, anchorMsgId: anchor });
  } catch (e) {
    // Motivo real del fallo (ej. timeout de summarize a los 180s) — antes se tragaba en
    // silencio, sin forma de diagnosticar por qué falló un ítem puntual (visto 2026-07-03).
    console.error(`[resumir] startStarredItem falló (id=${item.id}, "${item.title}"): ${e instanceof Error ? e.message : String(e)}`);
    failed = true;
  }
  // Si run() NO dejó una propuesta real (sin contenido o error), el lock sigue placeholder → limpiar.
  const cur = readJsonSafe<PendingProposal | null>(pendingPath(chatId), null);
  if (failed || (cur && cur.placeholder)) {
    try { unlinkSync(pendingPath(chatId)); } catch { /* noop */ }
    if (autoAdvanceOnFail) {
      // Ya quedó marcado como 'seen' (no se reprocesa) → des-estrellar también, para no dejar
      // una estrella huérfana en Feedbin de algo que el sistema descartó. Esperar antes de avanzar.
      await unstarFeedbinEntry(item.id);
      await setCardMessage(deps.botToken, chatId, anchor, `⚠️ No pude resumir "${escapeHtml(item.title)}" (sin contenido en Feedbin); lo descarto y le quito la estrella.`);
      await advanceStarredQueue(deps, chatId); // el siguiente crea su propio mensaje
    } else {
      // Selección puntual de Cal: NO auto-avanzar ni des-estrellar — devolver a la cola y avisar.
      const q = readJsonSafe<{ items: StarredItem[]; mode?: "batch" }>(STARRED_QUEUE, { items: [] });
      q.items.unshift(item);
      writeJsonSafe(STARRED_QUEUE, q);
      await setCardMessage(
        deps.botToken, chatId, anchor,
        `⚠️ No pude resumir "${escapeHtml(item.title)}" (sin contenido en Feedbin). Lo dejé de nuevo en la cola — no seguí con otro automáticamente. Decime "revisá los starred" para ver el selector de nuevo.`,
      );
    }
  }
}

// Propone el siguiente starred de la cola (si no hay propuesta pendiente activa). FIFO — usado
// en modo batch ("Procesar todos") y como fallback de auto-avance al fallar un ítem.
// anchorMsgId: mensaje a EDITAR como estado (del tap "Revisando..."); si falta, crea uno nuevo.
async function advanceStarredQueue(deps: ResumirDeps, chatId: number, anchorMsgId?: number): Promise<void> {
  if (existsSync(pendingPath(chatId))) return;
  const q = readJsonSafe<{ items: StarredItem[]; mode?: "batch" }>(STARRED_QUEUE, { items: [] });
  const next = q.items.shift();
  if (!next) {
    // Cola vacía: resetea el modo para que la próxima tanda de items nuevos vuelva a preguntar.
    delete q.mode;
    writeJsonSafe(STARRED_QUEUE, q);
    if (anchorMsgId != null) await setCardMessage(deps.botToken, chatId, anchorMsgId, "✅ Starred al día — no quedan por resumir.");
    return;
  }
  writeJsonSafe(STARRED_QUEUE, q);
  await startStarredItem(deps, chatId, next, anchorMsgId, true);
}

// Cron + on-demand: revisa los starred, encola los nuevos y arranca el primero.
// anchorMsgId: si viene de un tap del botón, ese mensaje se edita en todo el flujo (un solo mensaje).
export async function checkStarredResumir(deps: ResumirDeps, chatIdArg?: number, anchorMsgId?: number): Promise<{ status: string; message: string }> {
  if (!feedbinAuth()) return { status: "noop", message: "Sin credenciales de Feedbin." };
  const cfg = readJsonSafe<{ chatId?: number }>(PLAYLIST_CONFIG, {});
  const chatId = chatIdArg ?? cfg.chatId ?? 0;
  if (!chatId) return { status: "noop", message: "Sin chatId configurado." };
  const seen = new Set(readJsonSafe<{ ids: number[] }>(STARRED_SEEN, { ids: [] }).ids);
  const q = readJsonSafe<{ items: StarredItem[]; mode?: "batch" }>(STARRED_QUEUE, { items: [] });
  let added = 0;
  for (const it of await fetchStarredEntries()) {
    if (!seen.has(it.id)) {
      seen.add(it.id);
      if (!q.items.some((x) => x.id === it.id)) { q.items.push(it); added++; }
    }
  }
  writeJsonSafe(STARRED_SEEN, { ids: [...seen] });
  writeJsonSafe(STARRED_QUEUE, q);
  // Con ancla (tap): el mismo mensaje fluye al procesamiento; sin ancla (cron): notificar los nuevos.
  if (added > 0 && anchorMsgId == null) {
    await sendMessage(deps.botToken, { chatId, text: `⭐ ${added} starred nuevo(s) en Feedbin.`, parseMode: "HTML" }).catch(() => {});
  }
  if (q.items.length === 0) {
    if (anchorMsgId != null) await setCardMessage(deps.botToken, chatId, anchorMsgId, "👌 Revisé los starred: no hay nuevos.");
    return { status: "ok", message: added > 0 ? `${added} encolado(s).` : "Sin starred nuevos." };
  }
  // Hay items en cola. Si una propuesta está en curso, avisar; si no, mostrar el selector (o
  // seguir en FIFO si Cal ya eligió "Procesar todos" para esta tanda — modo batch).
  if (existsSync(pendingPath(chatId))) {
    const msg = `📋 Tenés una propuesta en curso. Resolvéla ("guardar" o "salta") y sigo con los starred (${q.items.length} en cola).`;
    if (anchorMsgId != null) await setCardMessage(deps.botToken, chatId, anchorMsgId, msg);
    else await sendMessage(deps.botToken, { chatId, text: msg, parseMode: "HTML" }).catch(() => {});
    return { status: "ok", message: `Propuesta en curso; ${q.items.length} en cola.` };
  }
  if (q.mode === "batch") {
    await advanceStarredQueue(deps, chatId, anchorMsgId);
    return { status: "ok", message: `Procesando cola de starred (${q.items.length}).` };
  }
  const sel = buildQueueSelector("s", q.items.map((it) => ({ id: it.id, title: it.title })));
  await setCardMessage(deps.botToken, chatId, anchorMsgId, sel.text, sel.keyboard);
  return { status: "ok", message: `Selector mostrado (${q.items.length} en cola).` };
}

// Tool: disparar la revisión de los starred a demanda.
export function revisarStarredResumir(deps: ResumirDeps, chatId: number): { status: string; message: string } {
  void checkStarredResumir(deps, chatId).then((r) => {
    if (r.status === "ok" && r.message.startsWith("Sin starred")) {
      void sendMessage(deps.botToken, { chatId, text: "👌 Revisé los starred de Feedbin: no hay nuevos.", parseMode: "HTML" }).catch(() => {});
    } else if (r.status === "noop") {
      void sendMessage(deps.botToken, { chatId, text: "No tengo credenciales de Feedbin configuradas.", parseMode: "HTML" }).catch(() => {});
    }
  }).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    void sendMessage(deps.botToken, { chatId, text: `❌ Error revisando los starred (${msg}).`, parseMode: "HTML" }).catch(() => {});
  });
  return { status: "started", message: "Revisando los starred de Feedbin en background..." };
}

// Corre un comando y devuelve TODO el stdout (yt-dlp -J imprime un JSON que runJson no parsea por líneas).
function runStdout(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
    if (!child.pid) { reject(new Error(`no se pudo arrancar ${cmd}`)); return; }
    child.unref();
    let out = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("timeout")); }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", () => { /* drenar stderr para no bloquear el pipe del SO */ });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", () => { clearTimeout(timer); resolve(out); });
  });
}

async function listPlaylistVideos(url: string): Promise<PlaylistVideo[]> {
  try {
    const out = await runStdout(YTDLP, ["--flat-playlist", "--no-warnings", "-J", url], 90_000);
    const d = JSON.parse(out) as { entries?: Array<{ id?: string; title?: string }> };
    return (d.entries ?? [])
      .filter((e): e is { id: string; title?: string } => !!e && typeof e.id === "string")
      .map((e) => ({ id: e.id, title: e.title ?? e.id, url: `https://youtu.be/${e.id}` }));
  } catch { return []; }
}

// Arranca a procesar UN video ya elegido (reserva el lock, edita el ancla, corre run()).
// Compartida entre el camino FIFO (shift(), modo batch) y el camino "por id" (splice desde
// resu-pick:v:{id}) — ver pickPlaylistItem. `autoAdvanceOnFail`: en modo batch, si falla, sigue
// solo con el siguiente (comportamiento de siempre); en una selección puntual de Cal, si falla,
// NO sigue con otro por su cuenta — avisa y para, para que Cal decida (pedido explícito de Cal,
// 2026-07-03: "no debería continuar sino preguntarme qué hacer si falla uno").
async function startPlaylistItem(deps: ResumirDeps, chatId: number, video: PlaylistVideo, anchorMsgId: number | undefined, autoAdvanceOnFail: boolean): Promise<void> {
  // Punto único de reset del flag de cancelación (ver startStarredItem): cada ítem arranca limpio,
  // sea elegido desde el selector o por FIFO automático.
  cancelRequested.delete(chatId);
  // Lock sincrónico: reserva el slot ANTES de transcribir (evita que otro advance haga doble shift en la ventana).
  writeJsonSafe(pendingPath(chatId), { title: video.title, url: video.url, kind: "video", html: "", tags: [], highlights: [], createdAt: Date.now(), fromPlaylist: true, videoId: video.id, placeholder: true } satisfies PendingProposal);
  // Ancla: reusa el mensaje del tap (edición) o crea uno nuevo. run() lo sigue editando por fases.
  const anchor = await setCardMessage(deps.botToken, chatId, anchorMsgId, `🎬 <b>${escapeHtml(video.title)}</b>\n⏳ Procesando...`, stopKeyboard());
  let failed = false;
  try {
    await run(deps, chatId, "video", { source: video.url }, { fromPlaylist: true, videoId: video.id, anchorMsgId: anchor });
  } catch (e) {
    // Motivo real del fallo (ej. timeout de summarize a los 180s) — antes se tragaba en
    // silencio, sin forma de diagnosticar por qué falló un ítem puntual (visto 2026-07-03).
    console.error(`[resumir] startPlaylistItem falló (id=${video.id}, "${video.title}"): ${e instanceof Error ? e.message : String(e)}`);
    failed = true;
  }
  // Si run() NO dejó una propuesta real (error o early-return), el lock sigue siendo placeholder → limpiar.
  const cur = readJsonSafe<PendingProposal | null>(pendingPath(chatId), null);
  if (failed || (cur && cur.placeholder)) {
    try { unlinkSync(pendingPath(chatId)); } catch { /* noop */ }
    if (autoAdvanceOnFail) {
      await setCardMessage(deps.botToken, chatId, anchor, `⚠️ No pude resumir "${escapeHtml(video.title)}", paso al siguiente.`);
      await advancePlaylistQueue(deps, chatId); // el siguiente crea su propio mensaje
    } else {
      // Devolver el video a la cola (al principio) para no perderlo — Cal decide si reintentar.
      const q = readJsonSafe<{ videos: PlaylistVideo[]; mode?: "batch" }>(PLAYLIST_QUEUE, { videos: [] });
      q.videos.unshift(video);
      writeJsonSafe(PLAYLIST_QUEUE, q);
      await setCardMessage(
        deps.botToken, chatId, anchor,
        `⚠️ No pude resumir "${escapeHtml(video.title)}". Lo dejé de nuevo en la cola — no seguí con otro automáticamente. Decime "revisá la playlist" para ver el selector de nuevo.`,
      );
    }
  }
}

// Propone el siguiente video de la cola (si no hay propuesta pendiente activa). FIFO — usado en
// modo batch ("Procesar todos") y como fallback de auto-avance al fallar un ítem.
// anchorMsgId: mensaje a EDITAR como estado (del tap "Revisando..."); si falta, crea uno nuevo.
async function advancePlaylistQueue(deps: ResumirDeps, chatId: number, anchorMsgId?: number): Promise<void> {
  if (existsSync(pendingPath(chatId))) return; // hay una propuesta en curso → esperar
  const q = readJsonSafe<{ videos: PlaylistVideo[]; mode?: "batch" }>(PLAYLIST_QUEUE, { videos: [] });
  const next = q.videos.shift();
  if (!next) {
    // Cola vacía: resetea el modo para que la próxima tanda de items nuevos vuelva a preguntar.
    delete q.mode;
    writeJsonSafe(PLAYLIST_QUEUE, q);
    if (anchorMsgId != null) await setCardMessage(deps.botToken, chatId, anchorMsgId, "✅ Playlist al día — no quedan videos por resumir.");
    else await sendMessage(deps.botToken, { chatId, text: "✅ Playlist al día — no quedan videos por resumir.", parseMode: "HTML" }).catch(() => {});
    return;
  }
  writeJsonSafe(PLAYLIST_QUEUE, q);
  await startPlaylistItem(deps, chatId, next, anchorMsgId, true);
}

// Tras resolver una propuesta, sacar el item de su origen y devolver una nota corta para PLEGAR en la
// tarjeta (NO manda mensaje suelto, así no se cuela entre los chunks del resumen del siguiente item).
async function cleanupProcessedSource(proposal: PendingProposal): Promise<string> {
  if (proposal.fromStarred && proposal.feedbinId) {
    return (await unstarFeedbinEntry(proposal.feedbinId)) ? " · 🧹 sin estrella" : "";
  }
  return (await removeVideoFromPlaylist(proposal.url)) ? " · 🧹 fuera de la playlist" : "";
}

// Tras resolver cualquier propuesta (guardar/saltar), si quedan items en cola y no hay otra propuesta, continuar.
// Drena primero la playlist de YouTube y luego los starred de Feedbin (nunca dos propuestas en paralelo).
// Si la cola quedó en modo batch ("Procesar todos"), sigue el FIFO automático de siempre; si no,
// vuelve a mostrar el selector (mensaje nuevo — acá no hay tap/ancla) para que Cal elija de nuevo.
async function maybeAdvance(deps: ResumirDeps, chatId: number): Promise<void> {
  if (existsSync(pendingPath(chatId))) return;
  const pq = readJsonSafe<{ videos: PlaylistVideo[]; mode?: "batch" }>(PLAYLIST_QUEUE, { videos: [] });
  if (pq.videos.length > 0) {
    if (pq.mode === "batch") { await advancePlaylistQueue(deps, chatId); return; }
    const sel = buildQueueSelector("v", pq.videos.map((v) => ({ id: v.id, title: v.title })));
    await sendMessage(deps.botToken, { chatId, text: sel.text, parseMode: "HTML", replyMarkup: sel.keyboard }).catch(() => {});
    return;
  }
  const sq = readJsonSafe<{ items: StarredItem[]; mode?: "batch" }>(STARRED_QUEUE, { items: [] });
  if (sq.items.length > 0) {
    if (sq.mode === "batch") { await advanceStarredQueue(deps, chatId); return; }
    const sel = buildQueueSelector("s", sq.items.map((it) => ({ id: it.id, title: it.title })));
    await sendMessage(deps.botToken, { chatId, text: sel.text, parseMode: "HTML", replyMarkup: sel.keyboard }).catch(() => {});
    return;
  }
}

// Cron handler: revisa las playlists configuradas, encola los videos nuevos y arranca el primero.
// anchorMsgId: si viene de un tap del botón, ese mensaje se edita en todo el flujo (un solo mensaje).
export async function checkPlaylistsResumir(deps: ResumirDeps, chatIdArg?: number, anchorMsgId?: number): Promise<{ status: string; message: string }> {
  const cfg = readJsonSafe<{ chatId?: number; playlists?: string[] }>(PLAYLIST_CONFIG, {});
  const chatId = chatIdArg ?? cfg.chatId ?? 0;
  if (!chatId || !Array.isArray(cfg.playlists) || cfg.playlists.length === 0) {
    if (anchorMsgId != null) await setCardMessage(deps.botToken, chatId || (cfg.chatId ?? 0), anchorMsgId, "No hay playlists configuradas para resumir.");
    return { status: "noop", message: "Sin playlists configuradas." };
  }
  const seen = new Set(readJsonSafe<{ ids: string[] }>(PLAYLIST_SEEN, { ids: [] }).ids);
  const q = readJsonSafe<{ videos: PlaylistVideo[]; mode?: "batch" }>(PLAYLIST_QUEUE, { videos: [] });
  let added = 0;
  for (const purl of cfg.playlists) {
    for (const v of await listPlaylistVideos(purl)) {
      if (!seen.has(v.id)) {
        seen.add(v.id);
        if (!q.videos.some((x) => x.id === v.id)) { q.videos.push(v); added++; }
      }
    }
  }
  writeJsonSafe(PLAYLIST_SEEN, { ids: [...seen] });
  writeJsonSafe(PLAYLIST_QUEUE, q);
  // Con ancla (tap): el mismo mensaje fluye al procesamiento; sin ancla (cron): notificar los nuevos.
  if (added > 0 && anchorMsgId == null) {
    await sendMessage(deps.botToken, { chatId, text: `🎬 ${added} video(s) nuevo(s) en tu playlist.`, parseMode: "HTML" }).catch(() => {});
  }
  if (q.videos.length === 0) {
    if (anchorMsgId != null) await setCardMessage(deps.botToken, chatId, anchorMsgId, "👌 Revisé la playlist: no hay videos nuevos.");
    return { status: "ok", message: added > 0 ? `${added} encolado(s).` : "Sin videos nuevos en la playlist." };
  }
  // Hay videos en cola. Si una propuesta está en curso, avisar; si no, mostrar el selector (o
  // seguir en FIFO si Cal ya eligió "Procesar todos" para esta tanda — modo batch).
  if (existsSync(pendingPath(chatId))) {
    const msg = `📋 Tenés una propuesta en curso. Resolvéla ("guardar" o "salta") y sigo con la playlist (${q.videos.length} en cola).`;
    if (anchorMsgId != null) await setCardMessage(deps.botToken, chatId, anchorMsgId, msg);
    else await sendMessage(deps.botToken, { chatId, text: msg, parseMode: "HTML" }).catch(() => {});
    return { status: "ok", message: `Propuesta en curso; ${q.videos.length} en cola.` };
  }
  if (q.mode === "batch") {
    await advancePlaylistQueue(deps, chatId, anchorMsgId);
    return { status: "ok", message: `Procesando cola (${q.videos.length} en cola).` };
  }
  const sel = buildQueueSelector("v", q.videos.map((v) => ({ id: v.id, title: v.title })));
  await setCardMessage(deps.botToken, chatId, anchorMsgId, sel.text, sel.keyboard);
  return { status: "ok", message: `Selector mostrado (${q.videos.length} en cola).` };
}

// Tool: disparar la revisión de la playlist a demanda.
export function revisarPlaylistResumir(deps: ResumirDeps, chatId: number): { status: string; message: string } {
  void checkPlaylistsResumir(deps, chatId).then((r) => {
    if (r.status === "ok" && r.message.startsWith("Sin videos")) {
      void sendMessage(deps.botToken, { chatId, text: "👌 Revisé la playlist: no hay videos nuevos.", parseMode: "HTML" }).catch(() => {});
    } else if (r.status === "noop") {
      void sendMessage(deps.botToken, { chatId, text: "No hay playlists configuradas para resumir.", parseMode: "HTML" }).catch(() => {});
    }
  }).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    void sendMessage(deps.botToken, { chatId, text: `❌ Error revisando la playlist (${msg}).`, parseMode: "HTML" }).catch(() => {});
  });
  return { status: "started", message: "Revisando la playlist en background..." };
}

// ───────────────── Callback resu-pick:{v|s}:{id|all|none} ─────────────────
// Interceptado MECÁNICAMENTE en index.ts (sin pasar por el LLM) — igual que j:resu:save/skip/etc.
// Cal elige, desde buildQueueSelector, un ítem puntual, "Procesar todos" (modo batch) o "Ahora no".

async function pickPlaylistItem(deps: ResumirDeps, chatId: number, id: string, anchorMsgId: number): Promise<void> {
  if (existsSync(pendingPath(chatId))) return; // ya hay una propuesta en curso (doble-tap/carrera) → noop
  const q = readJsonSafe<{ videos: PlaylistVideo[]; mode?: "batch" }>(PLAYLIST_QUEUE, { videos: [] });
  const idx = q.videos.findIndex((v) => v.id === id);
  if (idx === -1) {
    await setCardMessage(deps.botToken, chatId, anchorMsgId, "Ese video ya no está en la cola (puede que ya se haya procesado).");
    return;
  }
  const [video] = q.videos.splice(idx, 1);
  writeJsonSafe(PLAYLIST_QUEUE, q);
  // false: selección puntual de Cal — si falla, avisar y parar, no auto-avanzar a otro.
  await startPlaylistItem(deps, chatId, video, anchorMsgId, false);
}

async function pickPlaylistAll(deps: ResumirDeps, chatId: number, anchorMsgId: number): Promise<void> {
  const q = readJsonSafe<{ videos: PlaylistVideo[]; mode?: "batch" }>(PLAYLIST_QUEUE, { videos: [] });
  q.mode = "batch";
  writeJsonSafe(PLAYLIST_QUEUE, q);
  await advancePlaylistQueue(deps, chatId, anchorMsgId);
}

async function pickPlaylistNone(deps: ResumirDeps, chatId: number, anchorMsgId: number): Promise<void> {
  const q = readJsonSafe<{ videos: PlaylistVideo[] }>(PLAYLIST_QUEUE, { videos: [] });
  await setCardMessage(deps.botToken, chatId, anchorMsgId, `Ok, seguís con ${q.videos.length} pendiente(s) — pedime "revisá la playlist" cuando quieras.`);
}

async function pickStarredItem(deps: ResumirDeps, chatId: number, id: number, anchorMsgId: number): Promise<void> {
  if (existsSync(pendingPath(chatId))) return; // ya hay una propuesta en curso (doble-tap/carrera) → noop
  const q = readJsonSafe<{ items: StarredItem[]; mode?: "batch" }>(STARRED_QUEUE, { items: [] });
  const idx = q.items.findIndex((it) => it.id === id);
  if (idx === -1) {
    await setCardMessage(deps.botToken, chatId, anchorMsgId, "Ese starred ya no está en la cola (puede que ya se haya procesado).");
    return;
  }
  const [item] = q.items.splice(idx, 1);
  writeJsonSafe(STARRED_QUEUE, q);
  // false: selección puntual de Cal — si falla, avisar y parar, no auto-avanzar a otro.
  await startStarredItem(deps, chatId, item, anchorMsgId, false);
}

async function pickStarredAll(deps: ResumirDeps, chatId: number, anchorMsgId: number): Promise<void> {
  const q = readJsonSafe<{ items: StarredItem[]; mode?: "batch" }>(STARRED_QUEUE, { items: [] });
  q.mode = "batch";
  writeJsonSafe(STARRED_QUEUE, q);
  await advanceStarredQueue(deps, chatId, anchorMsgId);
}

async function pickStarredNone(deps: ResumirDeps, chatId: number, anchorMsgId: number): Promise<void> {
  const q = readJsonSafe<{ items: StarredItem[] }>(STARRED_QUEUE, { items: [] });
  await setCardMessage(deps.botToken, chatId, anchorMsgId, `Ok, seguís con ${q.items.length} pendiente(s) — pedime "revisá los starred" cuando quieras.`);
}

// Punto único llamado desde index.ts al recibir un callback `resu-pick:{kind}:{pick}` — kind es
// "v" (playlist) o "s" (starred), pick es el id elegido (videoId string / feedbinId numérico como
// string) o los literales "all"/"none". Dispatcher mecánico: no hay LLM de por medio.
export async function handleQueuePick(deps: ResumirDeps, chatId: number, kind: "v" | "s", pick: string, anchorMsgId: number): Promise<void> {
  if (kind === "v") {
    if (pick === "all") { await pickPlaylistAll(deps, chatId, anchorMsgId); return; }
    if (pick === "none") { await pickPlaylistNone(deps, chatId, anchorMsgId); return; }
    await pickPlaylistItem(deps, chatId, pick, anchorMsgId);
    return;
  }
  if (pick === "all") { await pickStarredAll(deps, chatId, anchorMsgId); return; }
  if (pick === "none") { await pickStarredNone(deps, chatId, anchorMsgId); return; }
  const id = Number(pick);
  if (Number.isNaN(id)) return; // callback_data corrupto/inesperado — no debería pasar
  await pickStarredItem(deps, chatId, id, anchorMsgId);
}

// Tool: reportar el estado del resumidor (propuesta en curso + cola de la playlist).
export function estadoResumidor(chatId: number): { status: string; message: string } {
  const lines: string[] = [];
  const p = pendingPath(chatId);
  if (existsSync(p)) {
    const prop = readJsonSafe<PendingProposal | null>(p, null);
    if (prop?.placeholder) {
      lines.push(`⏳ Procesando ahora: <b>${escapeHtml(prop.title || "contenido")}</b> (transcribiendo/resumiendo, ~1-3 min).`);
    } else if (prop) {
      lines.push(
        `📋 Propuesta lista para guardar: <b>${escapeHtml(prop.title || "—")}</b> — ` +
        `${prop.tags?.length ?? 0} tags, ${prop.highlights?.length ?? 0} highlights${prop.fromPlaylist ? " (de la playlist)" : ""}. ` +
        `Decí "guardar" o "salta".`,
      );
    } else {
      lines.push("Hay una propuesta pendiente pero no pude leerla; reenviá el link.");
    }
  } else {
    lines.push("Sin propuesta en curso.");
  }
  const q = readJsonSafe<{ videos: PlaylistVideo[] }>(PLAYLIST_QUEUE, { videos: [] });
  if (q.videos.length) {
    const titles = q.videos.slice(0, 12).map((v, i) => `${i + 1}. ${escapeHtml(v.title)}`).join("\n");
    const extra = q.videos.length > 12 ? `\n… y ${q.videos.length - 12} más` : "";
    lines.push(`\n🎬 En cola de la playlist (${q.videos.length}):\n${titles}${extra}`);
  }
  const sq = readJsonSafe<{ items: StarredItem[] }>(STARRED_QUEUE, { items: [] });
  if (sq.items.length) {
    const titles = sq.items.slice(0, 12).map((v, i) => `${i + 1}. ${escapeHtml(v.title)}`).join("\n");
    const extra = sq.items.length > 12 ? `\n… y ${sq.items.length - 12} más` : "";
    lines.push(`\n⭐ En cola de starred (${sq.items.length}):\n${titles}${extra}`);
  }
  return { status: "ok", message: lines.join("\n") };
}

// Tool: saltar (descartar sin guardar) la propuesta pendiente; si vino de la playlist, avanza a la siguiente.
export function saltarResumen(deps: ResumirDeps, chatId: number): { status: string; message: string } {
  void (async () => {
    const p = pendingPath(chatId);
    if (!existsSync(p)) {
      await sendMessage(deps.botToken, { chatId, text: "No hay ninguna propuesta pendiente para saltar.", parseMode: "HTML" }).catch(() => {});
      return;
    }
    const prop = readJsonSafe<PendingProposal | null>(p, null);
    if (prop && prop.placeholder) {
      await sendMessage(deps.botToken, { chatId, text: "⏳ Ese video todavía se está procesando; esperá el resumen para decidir si lo guardas o lo saltas.", parseMode: "HTML" }).catch(() => {});
      return;
    }
    try { unlinkSync(p); } catch { /* noop */ }
    const note = prop ? await cleanupProcessedSource(prop) : ""; // esperar el cleanup → no se cuela en el siguiente
    await setCardMessage(deps.botToken, chatId, prop?.messageId, `⏭️ <b>Descartado</b>${note} (no se guardó en Readwise).`);
    await maybeAdvance(deps, chatId);
  })().catch(() => {});
  return { status: "started", message: "Descarte iniciado: YA edito la tarjeta (⏭️ Descartado) y avanzo la cola solo. NO escribas texto ni preguntes si seguir — devolvé VACÍO." };
}

// Para la tanda: vacía las colas (playlist + starred) y deja de proponer. Si hay un ítem
// resumiéndose AHORA (placeholder), lo cancela y lo deja para después; si lo que hay arriba es una
// propuesta ya lista, la conserva (Cal la guarda/salta). Lo sacado de la cola vuelve al "revisar".
async function runDetener(deps: ResumirDeps, chatId: number): Promise<void> {
  const { botToken } = deps;
  // ¿Hay un ítem resumiéndose AHORA (placeholder)? Marcar cancelación: run() lo abortará en su
  // próximo checkpoint, lo dejará para después y editará su mensaje a "⏹️ Cancelado".
  const cur = readJsonSafe<PendingProposal | null>(pendingPath(chatId), null);
  const cancellingCurrent = !!(cur && cur.placeholder);
  if (cancellingCurrent) cancelRequested.add(chatId);
  const pq = readJsonSafe<{ videos: PlaylistVideo[] }>(PLAYLIST_QUEUE, { videos: [] });
  const sq = readJsonSafe<{ items: StarredItem[] }>(STARRED_QUEUE, { items: [] });
  const remaining = (pq.videos?.length ?? 0) + (sq.items?.length ?? 0);
  // Quitar de 'seen' lo encolado → reaparece si Cal vuelve a "revisar la playlist/starred".
  if (pq.videos?.length) {
    const seen = new Set(readJsonSafe<{ ids: string[] }>(PLAYLIST_SEEN, { ids: [] }).ids);
    for (const v of pq.videos) seen.delete(v.id);
    writeJsonSafe(PLAYLIST_SEEN, { ids: [...seen] });
  }
  if (sq.items?.length) {
    const seen = new Set(readJsonSafe<{ ids: number[] }>(STARRED_SEEN, { ids: [] }).ids);
    for (const it of sq.items) seen.delete(it.id);
    writeJsonSafe(STARRED_SEEN, { ids: [...seen] });
  }
  writeJsonSafe(PLAYLIST_QUEUE, { videos: [] });
  writeJsonSafe(STARRED_QUEUE, { items: [] });
  // El ítem en curso lo cancela y reporta run() (edita su propio mensaje a "⏹️ Cancelado").
  const tail = ' No te muestro más (vuelven si decís "revisa la playlist/starred").';
  let text: string;
  if (cancellingCurrent) {
    text = remaining
      ? `⏹️ <b>Parando</b> — cancelo el que se estaba resumiendo (queda para después) y saqué ${remaining} más de la cola.${tail}`
      : `⏹️ <b>Parando</b> — cancelo el que se estaba resumiendo; queda para después.${tail}`;
  } else {
    text = remaining
      ? `⏹️ <b>Paré la cola</b> — saqué ${remaining} pendiente(s).${tail} Si quedó una propuesta arriba, resolvéla con ✅ o ⏭️.`
      : `⏹️ <b>Listo</b> — no había nada más en cola.`;
  }
  await sendMessage(botToken, { chatId, text, parseMode: "HTML" }).catch(() => {});
}

// Tool/botón "⏹️ Parar la cola": detiene la tanda. Si hay un ítem resumiéndose, lo cancela
// (queda para después); una propuesta ya lista se conserva.
export function detenerResumidor(deps: ResumirDeps, chatId: number): { status: string; message: string } {
  void runDetener(deps, chatId).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    void sendMessage(deps.botToken, { chatId, text: `❌ Error al detener la cola (${msg}).`, parseMode: "HTML" }).catch(() => {});
  });
  return { status: "started", message: "YA paré la cola y avisé en Telegram. NO escribas texto de respuesta — devolvé VACÍO." };
}
