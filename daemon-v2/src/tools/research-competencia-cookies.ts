import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { matchesDomain, type StructuredCookie } from "./cookie-jar.js";

const HOME = homedir();
const SAFARI_COOKIES_PATH = `${HOME}/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies`;
const SAFARI_FETCH_SCRIPT = `${HOME}/.claude/scripts/safari-fetch.mjs`;

/**
 * Dominios sociales que este research necesita — lista PROPIA de este módulo, deliberadamente
 * separada de la whitelist global del Cookie Broker (`~/.claude/config/cookie-jar-domains.json`).
 * Esa whitelist también la consume `fetchAsUser`, invocable por el LLM de Jano con URL arbitraria:
 * sumarle facebook.com/tiktok.com ahí le daría acceso autenticado a Messenger/DMs. Este research
 * corre standalone (fuera de Jano) y lee la sesión de Safari directo, sin pasar por el broker ni
 * por esa whitelist, así que no hace falta (ni corresponde) tocar ese archivo para nada.
 */
export const SOCIAL_DOMAINS = ["instagram.com", "tiktok.com", "facebook.com", "x.com", "twitter.com"];

interface RawSafariCookie {
  domain: string;
  name: string;
  path: string;
  value: string;
  expiry: number;
}

export type SafariCookieReader = () => Buffer;
export type SafariCookieParser = (buf: Buffer) => RawSafariCookie[];

// Import dinámico (no estático) de parseSafariCookies desde ~/.claude/scripts/safari-fetch.mjs:
// ese directorio vive fuera del repo, es .mjs sin tipos y sin tsconfig propio. Un `import`
// estático rompería `tsc --noEmit` (no hay declaraciones para resolver) y un `require` no aplica
// bajo ESM. Reimplementar el parseo del formato binario .binarycookies acá duplicaría ~40 líneas
// ya pagadas en producción (bug-por-bug) sin necesidad — el import dinámico con ruta absoluta
// evita ambos problemas: TS tipa la expresión como `Promise<any>` sin intentar resolverla en
// build time, y en runtime carga el mismo parser probado. Se cachea tras la primera carga.
let cachedParser: SafariCookieParser | null = null;
async function loadDefaultParser(): Promise<SafariCookieParser> {
  if (!cachedParser) {
    const mod = (await import(SAFARI_FETCH_SCRIPT)) as { parseSafariCookies: SafariCookieParser };
    cachedParser = mod.parseSafariCookies;
  }
  return cachedParser;
}

export interface ResearchCompetenciaCookiesDeps {
  /** Lee el archivo binario de cookies de Safari. Default: readFileSync sobre la ruta real —
   * requiere Full Disk Access, por eso es inyectable (los tests no tocan el archivo real). */
  readCookiesFile?: SafariCookieReader;
  /** Parsea el buffer .binarycookies. Default: carga dinámica de parseSafariCookies (ver
   * loadDefaultParser). Inyectable para no depender de un .binarycookies real en los tests. */
  parseCookies?: SafariCookieParser;
  /** Reloj inyectable (epoch ms) para testear el filtro de expiración sin depender de la hora real. */
  reloj?: () => number;
}

/**
 * Crea un proveedor de cookies `(hostname) => Promise<StructuredCookie[]>` — misma firma que
 * `getCookies` en research-competencia.ts/research-competencia-social.ts, pero leyendo la sesión
 * de Safari DIRECTO en vez del Cookie Broker (KV). Fail-closed en dos niveles: hostname fuera de
 * `SOCIAL_DOMAINS` devuelve [] sin leer el archivo; fallo de lectura (típicamente falta de Full
 * Disk Access, ver `node-fda` en el CLAUDE.md del repo) devuelve [] con un log explícito — es el
 * modo de falla más probable en producción y tiene que diagnosticarse sin abrir código.
 */
export function makeResearchCompetenciaCookiesProvider(
  deps: ResearchCompetenciaCookiesDeps = {},
): (hostname: string) => Promise<StructuredCookie[]> {
  const readCookiesFile = deps.readCookiesFile ?? (() => readFileSync(SAFARI_COOKIES_PATH));
  const reloj = deps.reloj ?? Date.now;

  return async (hostname: string) => {
    const domain = SOCIAL_DOMAINS.find((d) => matchesDomain(hostname, d));
    if (!domain) return [];

    let raw: RawSafariCookie[];
    try {
      const parseCookies = deps.parseCookies ?? (await loadDefaultParser());
      raw = parseCookies(readCookiesFile());
    } catch (err) {
      console.log(JSON.stringify({
        ts: Date.now(),
        msg: "research_competencia_cookies_read_failed",
        hostname,
        hint: "probablemente falta Full Disk Access para leer Cookies.binarycookies de Safari -- correr con ~/.claude/bin/node-fda",
        err: String(err),
      }));
      return [];
    }

    const nowSeconds = Math.floor(reloj() / 1000);
    return raw
      .filter((c) => c.value && c.name && !(c.expiry > 0 && c.expiry < nowSeconds) && matchesDomain(hostname, c.domain))
      .map((c) => ({ name: c.name, value: c.value, domain: `.${domain}`, path: c.path || "/" }));
  };
}
