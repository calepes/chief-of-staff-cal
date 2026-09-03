import type { CfKv } from "../cf-kv.js";
import { findWhitelistedDomain, getCookieHeader } from "./cookie-jar.js";

// Safari 18 on macOS Sequoia
const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15";

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

// Extrae el título real de la página: <title>, con fallback a og:title. Copiado de
// ~/.claude/scripts/safari-fetch.mjs (misma lógica) para no perder el título al migrar
// resumir.ts de spawnear ese script a llamar fetchAsUser() en proceso.
function extractTitle(html: string): string {
  let m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Bloqueo de rutas de mensajería privada (Messenger, DMs de X/Twitter/Instagram/TikTok).
//
// POR QUÉ EXISTE: la whitelist del Cookie Broker (~/.claude/config/cookie-jar-domains.json) es
// GLOBAL al daemon — whitelistear un dominio habilita las cookies de sesión reales de Cal para
// TODO consumidor del broker, no solo para el caso que motivó agregarlo. fetchAsUser está expuesta
// al LLM con URL ARBITRARIA (agent-tools.ts: `async ({ url }) => asText(await fetchAsUser(url, ...))`),
// así que si un dominio de red social entra a la whitelist (x.com/twitter.com/instagram.com ya están,
// autorizado 2026-07-31 para el skill de referencias de diseño), el modelo puede pedir
// "https://facebook.com/messages" y recibir el contenido de Messenger autenticado de Cal. Los
// DENY_PATTERNS de cookie-jar.ts NO cubren esto: filtran por DOMINIO al momento de whitelistear
// (banca, webmail), no por RUTA al momento de fetchear — la regla dura "nunca email" de ese módulo
// no tenía ningún código defendiéndola para el caso de mensajería privada de redes sociales.
// Esto importa en particular porque Jano ingesta contenido NO CONFIABLE de rutina (resumidor,
// fetchAndSummarize, scraping) — una inyección de prompt en una página que Jano lee podría dirigir
// fetchAsUser a la bandeja de mensajes y exfiltrar contenido privado a través del propio bot.
//
// Matching fail-closed: URL no parseable → bloqueado. Comparación por hostname/path normalizados
// (minúsculas) y por SEGMENTO de path, no substring — evita que "/messages-de-prensa" bloquee de más
// y que "/MESSAGES", "//messages" o "/./messages" esquiven el filtro (WHATWG URL ya colapsa
// dot-segments y normaliza el hostname a minúsculas al parsear).
interface MessagingRule {
  domain: string;
  // Segmento exacto de path que bloquea (ej. "messages"). null = dominio entero es mensajería.
  segment: string | null;
}

const MESSAGING_RULES: MessagingRule[] = [
  { domain: "facebook.com", segment: "messages" },
  { domain: "messenger.com", segment: null },
  { domain: "x.com", segment: "messages" },
  { domain: "twitter.com", segment: "messages" },
  { domain: "instagram.com", segment: "direct" },
  { domain: "tiktok.com", segment: "messages" },
];

export function isPrivateMessagingUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true; // fail-closed: si no parsea, no confiamos en él
  }

  const hostname = parsed.hostname.toLowerCase();
  const firstSegment = parsed.pathname
    .toLowerCase()
    .split("/")
    .find((s) => s.length > 0);

  for (const rule of MESSAGING_RULES) {
    const matchesDomain = hostname === rule.domain || hostname.endsWith(`.${rule.domain}`);
    if (!matchesDomain) continue;
    if (rule.segment === null) return true;
    if (firstSegment === rule.segment) return true;
  }
  return false;
}

function logBlockedMessagingUrl(url: string): void {
  let hostname = "(no parseable)";
  let segment = "";
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname.toLowerCase();
    segment = parsed.pathname.toLowerCase().split("/").find((s) => s.length > 0) ?? "";
  } catch {
    // hostname/segment quedan con el default — nunca logueamos el URL crudo (puede traer tokens)
  }
  console.log(
    JSON.stringify({ ts: Date.now(), msg: "fetch_as_user_blocked_messaging", hostname, segment }),
  );
}

export interface FetchAsUserResult {
  ok: boolean;
  status: number;
  url: string;
  cookiesUsed: number;
  text: string;
  title: string;
  error?: string;
  // true si el hostname está en la whitelist del Cookie Broker (~/.claude/config/cookie-jar-domains.json)
  // — independiente de si había o no una cookie sincronizada en ese momento. false indica que, si el
  // contenido sale bloqueado/corto, se le puede proponer a Cal agregar el dominio (tool addCookieJarDomain).
  domainWhitelisted: boolean;
}

// Lee cookies del Cookie Broker (KV neutral "cookie-jar", ver ~/Claude Projects/HANDOFF-cookie-broker-kv.md)
// en vez de leer Cookies.binarycookies de Safari directo — ya no depende de Full Disk Access para el
// caso normal (dominio ya whitelisteado). Dominios no whitelisteados se fetchean igual, sin cookie
// (mismo comportamiento de siempre para contenido público).
export async function fetchAsUser(
  url: string,
  cookieJarKv: CfKv,
  timeoutMs = 15000,
  fetchFn: typeof fetch = fetch,
): Promise<FetchAsUserResult> {
  // Chequeo ANTES de resolver cookies — ver comentario de isPrivateMessagingUrl arriba. Si está
  // bloqueado, no se hace fetch en absoluto (ni con cookies ni sin ellas).
  if (isPrivateMessagingUrl(url)) {
    logBlockedMessagingUrl(url);
    return {
      ok: false,
      status: 0,
      url,
      cookiesUsed: 0,
      text: "",
      title: "",
      error: "Bloqueado por seguridad: es una ruta de mensajería privada (Messenger/DMs), no contenido público.",
      domainWhitelisted: false,
    };
  }

  let cookiesUsed = 0;
  let cookieHeader = "";
  let domainWhitelisted = false;

  try {
    const hostname = new URL(url).hostname;
    domainWhitelisted = findWhitelistedDomain(hostname) !== null;
    const header = await getCookieHeader(hostname, cookieJarKv);
    if (header) {
      cookieHeader = header;
      cookiesUsed = header.split(";").map((s) => s.trim()).filter(Boolean).length;
    }
  } catch {
    // lookup de whitelist/KV falló — seguir sin cookie (contenido público igual accesible)
  }

  const headers: Record<string, string> = {
    "User-Agent": SAFARI_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-BO,es;q=0.9,en;q=0.8",
  };

  if (cookieHeader) {
    headers["Cookie"] = cookieHeader;
  }

  try {
    const res = await fetchFn(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });

    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    const isHtml = contentType.includes("text/html");
    const title = isHtml ? extractTitle(raw) : "";
    let text = isHtml ? stripHtml(raw) : raw;

    if (text.length > 50000) {
      text = text.slice(0, 50000) + "\n[TRUNCADO — el artículo continúa más allá de 50k chars]";
    }

    return { ok: res.ok, status: res.status, url: res.url, cookiesUsed, text, title, domainWhitelisted };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, url, cookiesUsed, text: "", title: "", error: msg, domainWhitelisted };
  }
}
