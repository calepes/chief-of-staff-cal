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
export async function fetchAsUser(url: string, cookieJarKv: CfKv, timeoutMs = 15000): Promise<FetchAsUserResult> {
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
    const res = await fetch(url, {
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
