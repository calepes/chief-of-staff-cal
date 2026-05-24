import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const SAFARI_COOKIES_PATH =
  `${homedir()}/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies`;

// Seconds between Unix epoch (1970) and Apple epoch (2001)
const APPLE_EPOCH_OFFSET = 978307200;

// Safari 18 on macOS Sequoia
const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15";

interface SafariCookie {
  domain: string;
  name: string;
  path: string;
  value: string;
  expiry: number; // unix timestamp
}

// Minimal parser for Apple .binarycookies format
// Format: https://devgypsy.com/post/2021-08-17-reverse-engineering/
function parseSafariCookies(buf: Buffer): SafariCookie[] {
  if (buf.toString("ascii", 0, 4) !== "cook") {
    throw new Error("Not a valid .binarycookies file");
  }

  const numPages = buf.readUInt32BE(4);
  const pageSizes: number[] = [];
  for (let i = 0; i < numPages; i++) {
    pageSizes.push(buf.readUInt32BE(8 + i * 4));
  }

  const cookies: SafariCookie[] = [];
  let pageStart = 8 + numPages * 4;

  for (let p = 0; p < numPages; p++) {
    const size = pageSizes[p];
    const page = buf.subarray(pageStart, pageStart + size);
    pageStart += size;

    // Page: 4 bytes magic, 4 bytes numCookies (LE), then cookie offsets (LE)
    const numCookies = page.readUInt32LE(4);
    for (let c = 0; c < numCookies; c++) {
      const cookieOff = page.readUInt32LE(8 + c * 4);
      try {
        cookies.push(parseCookieRecord(page, cookieOff));
      } catch {
        // skip malformed records
      }
    }
  }

  return cookies;
}

function parseCookieRecord(buf: Buffer, off: number): SafariCookie {
  // off+0:  size (4 LE)
  // off+4:  unknown/version (4 LE)
  // off+8:  flags (4 LE) — bit 0=secure, bit 2=httpOnly
  // off+12: hasPort (4 LE)
  // off+16: domainOffset (4 LE) relative to record start
  // off+20: nameOffset (4 LE)
  // off+24: pathOffset (4 LE)
  // off+28: valueOffset (4 LE)
  // off+32: commentOffset (4 LE)
  // off+36: commentURLOffset (4 LE)
  // off+40: expiry (8 bytes double LE, Apple epoch)
  // off+48: creation (8 bytes double LE, Apple epoch)
  // off+56+: null-terminated strings

  const domainOff = buf.readUInt32LE(off + 16);
  const nameOff   = buf.readUInt32LE(off + 20);
  const pathOff   = buf.readUInt32LE(off + 24);
  const valueOff  = buf.readUInt32LE(off + 28);
  const expiry    = buf.readDoubleLE(off + 40);

  const readStr = (relOff: number): string => {
    const abs = off + relOff;
    const end = buf.indexOf(0, abs);
    return buf.toString("utf8", abs, end >= abs ? end : abs + 256);
  };

  const domain = readStr(domainOff).replace(/^\./, "");

  return {
    domain,
    name:   readStr(nameOff),
    path:   readStr(pathOff),
    value:  readStr(valueOff),
    expiry: Math.round(expiry) + APPLE_EPOCH_OFFSET,
  };
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
  error?: string;
}

export async function fetchAsUser(url: string, timeoutMs = 15000): Promise<FetchAsUserResult> {
  let cookiesUsed = 0;
  let cookieHeader = "";

  try {
    const hostname = new URL(url).hostname;
    const buf = readFileSync(SAFARI_COOKIES_PATH);
    const cookies = parseSafariCookies(buf);
    const now = Math.floor(Date.now() / 1000);

    const relevant = cookies.filter((c) => {
      if (!c.value || !c.name) return false;
      if (c.expiry > 0 && c.expiry < now) return false; // expired
      return hostname.endsWith(c.domain) || c.domain.endsWith(hostname);
    });

    cookiesUsed = relevant.length;
    cookieHeader = relevant.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("EACCES") || msg.includes("EPERM") || msg.includes("operation not permitted")) {
      return {
        ok: false, status: 0, url, cookiesUsed: 0, text: "",
        error: "Sin permiso para leer Cookies.binarycookies. Ir a Sistema > Privacidad > Acceso completo al disco y agregar el proceso node.",
      };
    }
    // cookie read failed — continue without cookies (public content still accessible)
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
    let text = await res.text();

    if (contentType.includes("text/html")) {
      text = stripHtml(text);
    }

    if (text.length > 50000) {
      text = text.slice(0, 50000) + "\n[TRUNCADO — el artículo continúa más allá de 50k chars]";
    }

    return { ok: res.ok, status: res.status, url: res.url, cookiesUsed, text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, url, cookiesUsed, text: "", error: msg };
  }
}
