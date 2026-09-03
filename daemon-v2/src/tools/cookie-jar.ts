import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { CfKv } from "../cf-kv.js";

// Cookie Broker — lado lector/administrador para Jano. La cookie real se escribe por un proceso
// externo (~/.claude/scripts/sync-safari-cookies.mjs, cron 05:40 con FDA — ver Fase 1 en
// ~/Claude Projects/HANDOFF-cookie-broker-kv.md); acá solo se LEE del KV neutral "cookie-jar" y,
// cuando aparece un dominio nuevo (con el conforme de Cal en el chat), se dispara una sincronización
// puntual reusando ese mismo script — Jano no vuelve a parsear Cookies.binarycookies directamente.
const HOME = homedir();
const DOMAINS_CONFIG_PATH = `${HOME}/.claude/config/cookie-jar-domains.json`;
const NODE_FDA = `${HOME}/.claude/bin/node-fda`;
const SYNC_SCRIPT = `${HOME}/.claude/scripts/sync-safari-cookies.mjs`;
const SYNC_TIMEOUT_MS = 45_000;

export const COOKIE_JAR_NAMESPACE_ID = "f6bfb90d3dbc48a29b4dc431e9d83c5b";

const CONFIG_COMMENT =
  "Whitelist de dominios permitidos en el Cookie Broker KV (namespace 'cookie-jar', Cloudflare " +
  "account id de Cal). REGLA DURA: solo medios de noticias/lectura. NUNCA banca, financieras, " +
  "Gmail/email, ni ningun sitio con datos sensibles. Editar a mano para sumar/quitar dominios -- " +
  "ver ~/Claude Projects/HANDOFF-cookie-broker-kv.md.";

// Defensa en profundidad de la regla dura de seguridad: aunque el system prompt ya instruye a Jano
// a no proponer nunca estos dominios, addDomainAndSync() los rechaza por código igual — no depende
// solo de que el LLM se porte bien.
const DENY_PATTERNS = [
  // Email / webmail — substring "mail" cubre gmail/hotmail/outlook/protonmail/icloud mail/
  // yahoo mail/zoho mail/aol mail y subdominios tipo mail./webmail./correo. sin enumerar cada uno.
  /mail/i, /correo/i, /outlook/i, /icloud\.com$/i, /yahoo\./i, /fastmail/i, /zoho\.com$/i, /aol\.com$/i,
  // Banca/financieras — Bolivia, Perú y genéricas. Lista de instituciones conocidas de Cal
  // (Bolivia: BNB, BISA, FIE, Ganadero, Fassil, Económico, Unión, Prodem, BMSC/Mercantil Santa
  // Cruz, Banco Sol, Fortaleza; Perú: BCP, Interbank, BBVA, Scotiabank) además de patrones genéricos.
  /banco/i, /^bank/i, /\bbank/i, /\bbanking\b/i,
  /bcp\./i, /bnb\.com/i, /bisa\.com/i, /fie\.com/i, /ganadero\.com/i, /fassil\.com/i,
  /baneco\.com/i, /bancounion\.com/i, /prodem\.com/i, /bmsc\.com/i, /mercantilsantacruz/i,
  /bancosol/i, /bancofortaleza/i, /bbva/i, /scotiabank/i, /interbank/i,
  /yape/i, /paypal/i, /wise\.com/i, /mercadopago/i, /binance/i, /coinbase/i,
];

interface DomainsConfig {
  ttlSeconds: number;
  domains: { domain: string }[];
}

function loadConfig(): DomainsConfig {
  const parsed = JSON.parse(readFileSync(DOMAINS_CONFIG_PATH, "utf8"));
  return { ttlSeconds: parsed.ttlSeconds ?? 86400, domains: Array.isArray(parsed.domains) ? parsed.domains : [] };
}

function saveConfig(cfg: DomainsConfig): void {
  const out = { _comment: CONFIG_COMMENT, ttlSeconds: cfg.ttlSeconds, domains: cfg.domains };
  writeFileSync(DOMAINS_CONFIG_PATH, JSON.stringify(out, null, 2) + "\n");
}

// true si candidateDomain y configuredDomain son el mismo dominio o uno es subdominio del otro.
// Misma lógica que digest-project/src/gated-sources.js y ~/.claude/scripts/sync-safari-cookies.mjs.
export function matchesDomain(candidate: string, configured: string): boolean {
  if (!candidate || !configured) return false;
  const a = candidate.toLowerCase();
  const b = configured.toLowerCase();
  return a === b || a.endsWith("." + b) || b.endsWith("." + a);
}

export function findWhitelistedDomain(hostname: string): string | null {
  const cfg = loadConfig();
  return cfg.domains.find((d) => matchesDomain(hostname, d.domain))?.domain ?? null;
}

export function isDomainAllowed(domain: string): boolean {
  return !DENY_PATTERNS.some((p) => p.test(domain));
}

// Busca la cookie de un hostname en el KV neutral, SOLO si está en la whitelist — hostnames no
// whitelisteados devuelven null sin siquiera consultar el KV.
export async function getCookieHeader(hostname: string, kv: CfKv): Promise<string | null> {
  const domain = findWhitelistedDomain(hostname);
  if (!domain) return null;
  return kv.getText(`cookie:${domain}`);
}

function runSyncScript(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(NODE_FDA, [SYNC_SCRIPT], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, output: "timeout esperando la sincronización" }); }, SYNC_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: code === 0 ? out : (err || out) });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: e.message });
    });
  });
}

export interface AddDomainResult {
  added: boolean;
  synced: boolean;
  message: string;
}

// Agrega un dominio a la whitelist y sincroniza su cookie AHORA (sin esperar al cron 05:40),
// reusando ~/.claude/scripts/sync-safari-cookies.mjs. Debe llamarse SOLO después de que Cal
// confirme explícitamente en el chat — la tool que expone esto (agent-tools.ts) lo deja claro
// en su descripción, y acá además se aplica el filtro DENY_PATTERNS como respaldo.
export async function addDomainAndSync(domainRaw: string): Promise<AddDomainResult> {
  const domain = domainRaw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!domain || !domain.includes(".")) {
    return { added: false, synced: false, message: `"${domainRaw}" no parece un dominio válido.` };
  }
  if (!isDomainAllowed(domain)) {
    return { added: false, synced: false, message: `Dominio "${domain}" bloqueado por regla dura de seguridad (solo medios de noticias/lectura — nunca banca, financieras ni email).` };
  }

  const cfg = loadConfig();
  const already = cfg.domains.some((d) => matchesDomain(domain, d.domain));
  if (!already) {
    cfg.domains.push({ domain });
    saveConfig(cfg);
  }

  const result = await runSyncScript();
  if (!result.ok) {
    return { added: true, synced: false, message: `Agregué "${domain}" a la whitelist, pero la sincronización falló: ${result.output.slice(0, 300)}` };
  }

  const domainSynced = result.output.includes(`${domain}: cookie actualizada`);
  return {
    added: true,
    synced: domainSynced,
    message: domainSynced
      ? `Agregué "${domain}" a la whitelist y sincronicé la cookie — ya puedo leer contenido paywalled de ahí.`
      : `Agregué "${domain}" a la whitelist, pero no encontré sesión activa en Safari para ese dominio. Iniciá sesión ahí y pedime que reintente.`,
  };
}

export interface StructuredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export interface StructuredCookiesResult {
  whitelisted: boolean;
  domain: string | null;
  cookies: StructuredCookie[];
}

function parseCookieHeaderToStructured(header: string, domain: string): StructuredCookie[] {
  return header
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf("=");
      // domain CON el punto inicial (".threads.com") en vez de url ("https://threads.com"):
      // Playwright trata el shorthand `url` como cookie host-only, que Chromium nunca manda en
      // pedidos a un subdominio real (ej. www.threads.com) — encontrado en producción 2026-08-01,
      // la sesión estaba bien sincronizada pero threads.com/share/... seguía mostrando el muro de
      // login porque el navegador jamás mandaba la cookie a www.threads.com. El punto inicial
      // replica el atributo real `Domain=.threads.com` que el sitio real usa para que la cookie
      // aplique a cualquier subdominio.
      return { name: pair.slice(0, idx), value: pair.slice(idx + 1), domain: `.${domain}`, path: "/" };
    });
}

/**
 * Como getCookieHeader, pero en el formato que acepta context.addCookies() de Playwright
 * ({name, value, domain, path} por cookie) en vez del header HTTP crudo — ese header solo sirve
 * para fetchAsUser. Usado por guardarReferenciaDiseno para autenticar la captura de X/Instagram.
 */
export async function getStructuredCookies(hostname: string, kv: CfKv): Promise<StructuredCookiesResult> {
  const domain = findWhitelistedDomain(hostname);
  if (!domain) return { whitelisted: false, domain: null, cookies: [] };
  const header = await kv.getText(`cookie:${domain}`);
  return { whitelisted: true, domain, cookies: header ? parseCookieHeaderToStructured(header, domain) : [] };
}
