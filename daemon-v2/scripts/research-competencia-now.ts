import { config as loadEnv } from "dotenv";
loadEnv({ path: `${process.env.HOME}/.cos-agent/.env` });
// notifications/.env ANTES de apps.env a propósito: NOTIF_BOT_TOKEN vive nativamente en
// ~/.claude/notifications/.env (es la config propia del bot @ClaudeCalbot — ver
// ~/AI Projects/telegram-reference.md), y apps.env solo tiene una COPIA para que loaders
// que no conocen notifications/.env (como el resto de los scripts cross-project) igual lo
// encuentren. dotenv es no-override (primer loadEnv gana), así que el orden importa: con
// apps.env cargado primero, la copia gana siempre y notifications/.env nunca aplica — hoy da
// igual porque son el mismo valor, pero divergirían en silencio el día que se roten por separado.
loadEnv({ path: `${process.env.HOME}/.claude/notifications/.env` });
loadEnv({ path: `${process.env.HOME}/.claude/secrets/apps.env` });

// Fuerza auth OAuth Max (Keychain) — sin esto, si hay una API key de Tier 1 en el
// entorno, el SDK la usa y tira 429. index.ts hace esto una vez por el daemon;
// este script es un proceso aparte, así que lo repite acá.
delete process.env.ANTHROPIC_API_KEY;

import { runResearchCompetencia, formatSummaryHtml } from "../src/tools/research-competencia.js";
import { stripHtmlTags } from "../src/proactive/rich-send.js";
import { sendNotifySummary, notifyFatalError, wantsNoNotify } from "./research-competencia-notify.js";
import { findMissingEnvVars, formatMissingEnvError } from "./research-competencia-env.js";
import { resolveApifyToken } from "./research-competencia-apify-token.js";
import { resolveD1Credentials } from "./research-competencia-cf-token.js";
import { resolveSharedSecrets } from "./research-competencia-shared-secrets.js";

/**
 * Corre el research de competencia fuera del daemon de Jano — ya no vive ahí, corre standalone
 * disparado por un cron externo de launchd (el plist se crea/mantiene aparte, fuera de este repo).
 * `npm run research:now -- --timeframe=14 --entidades=takenos,meru [--no-notify]`
 *
 * **La sesión social vive en un perfil de Chrome dedicado, no en Safari.** `runResearchCompetencia`
 * abre Chrome real (research-competencia-browser.ts) con el perfil
 * `~/.cos-agent/research-competencia-chrome-profile`. La PRIMERA vez (o cuando la sesión expire),
 * Cal tiene que loguearse a mano en Instagram/Facebook/TikTok/X en ese perfil — correr
 * `npm run research:chrome-login` (ventana visible, script interactivo) y persiste en disco entre
 * corridas. Sin login ahí, el scraping social corre igual pero sin sesión (mismo síntoma que
 * cualquier cuenta sin loguear: `research_competencia_scrape_empty`).
 *
 * ⚠️ Reemplaza el diseño anterior (leer Cookies.binarycookies de Safari con Full Disk Access vía
 * `node-fda`) — descartado 2026-09-03: Chromium headless con cookie de sesión válida seguía
 * devolviendo 0 posts (detección de bot), y Chrome real vía CDP es la respuesta ya validada en
 * este repo para ese problema (mismo patrón que `boa-checkin`). Ya NO hace falta FDA para esto —
 * el binario sigue invocándose vía `node-fda` (`research:now` en `package.json`) porque no hace
 * daño tenerlo y evita otro cambio de infra sin necesidad real, no porque siga siendo requisito.
 *
 * OPENROUTER_API_KEY/ELEVENLABS_API_KEY/NOTIF_BOT_TOKEN llegan primero en texto plano por los
 * `loadEnv()` de arriba (apps.env) — se mantiene como red de seguridad — pero `resolveSharedSecrets()`
 * (research-competencia-shared-secrets.ts) las SOBREESCRIBE con el valor real leído del vault
 * `Daemons` de 1Password (pedido de Cal 2026-09-09, los 4 ítems ya existían ahí porque el daemon
 * real los usa vía apps-env.1password.tpl). Fail-soft por credencial: si `op`/el Service Account
 * fallan, cada una queda con el valor de apps.env que ya tenía cargado — nunca rompe el arranque.
 *
 * `APIFY_TOKEN` (Facebook/TikTok orgánico, research-competencia-apify.ts) y las credenciales D1
 * (`CF_API_TOKEN_D1_RESEARCH_COMPETENCIA`/`D1_RESEARCH_COMPETENCIA_DATABASE_ID`) son distintas: son
 * secretos NUEVOS (nunca existieron en apps.env), así que ahí NO hay red de seguridad en texto
 * plano que caiga si 1Password falla — `resolveApifyToken()`/`resolveD1Credentials()`
 * (research-competencia-apify-token.ts / research-competencia-cf-token.ts) son la ÚNICA fuente.
 * Mismo mecanismo de Service Account que `resolveSharedSecrets()`. Fail-soft: si no resuelven, el
 * research sigue corriendo igual — Facebook/TikTok orgánico quedan sin datos, y D1
 * (histórico/dedupe de posts) degrada sin bloquear el resto del research.
 */
async function main(): Promise<void> {
  for (const [envVar, value] of resolveSharedSecrets()) {
    process.env[envVar] = value;
  }

  if (!process.env.APIFY_TOKEN) {
    const token = resolveApifyToken();
    if (token) process.env.APIFY_TOKEN = token;
  }

  if (!process.env.CF_API_TOKEN_D1_RESEARCH_COMPETENCIA || !process.env.D1_RESEARCH_COMPETENCIA_DATABASE_ID) {
    const d1Credentials = resolveD1Credentials();
    if (d1Credentials) {
      process.env.CF_API_TOKEN_D1_RESEARCH_COMPETENCIA = d1Credentials.token;
      process.env.D1_RESEARCH_COMPETENCIA_DATABASE_ID = d1Credentials.databaseId;
    }
  }

  const faltantes = findMissingEnvVars(process.env);
  if (faltantes.length > 0) {
    console.error(formatMissingEnvError(faltantes));
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const timeframeArg = args.find((a) => a.startsWith("--timeframe="));
  const entidadesArg = args.find((a) => a.startsWith("--entidades="));
  const timeframeDiasRaw = timeframeArg ? Number(timeframeArg.split("=")[1]) : undefined;
  const timeframeDias = Number.isFinite(timeframeDiasRaw) ? timeframeDiasRaw : undefined;
  const entidadIds = entidadesArg ? entidadesArg.split("=")[1].split(",").map((s) => s.trim()) : undefined;

  console.log("Corriendo research de competencia... (puede tardar entre 10 y 45 minutos)");
  const result = await runResearchCompetencia({ timeframeDias, entidadIds });
  const html = formatSummaryHtml(result);
  console.log(stripHtmlTags(html));

  if (wantsNoNotify(args)) return;

  // El research ya corrió y ya escribió en Notion — un fallo acá (token faltante o de red) no
  // invalida ese trabajo, solo se pierde el aviso por Telegram. Se avisa por consola y se sigue.
  const sent = await sendNotifySummary(html);
  if (!sent.ok) {
    console.log(`⚠️ No pude mandar el resumen por @ClaudeCalbot: ${sent.reason}`);
  }
}

main().catch(async (err) => {
  console.error("Error:", err);
  // BLOQUEANTE 1 (revisión de salud, 2026-09-03): antes esto era solo console.error — bajo un cron
  // desatendido de launchd nadie lee ese log, así que una excepción no capturada (fuera del
  // try/catch por entidad de runResearchCompetencia, ej. un bug en createInformePage) dejaba a Cal
  // sin resumen NI aviso de que el research falló. Ver notifyFatalError (research-competencia-notify.ts).
  const sent = await notifyFatalError(err).catch((notifyErr) => ({
    ok: false as const,
    reason: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
  }));
  if (!sent.ok) console.error(`Además, no pude avisar por Telegram: ${sent.reason}`);
  process.exit(1);
});
