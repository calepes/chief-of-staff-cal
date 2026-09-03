import { config as loadEnv } from "dotenv";
loadEnv({ path: `${process.env.HOME}/.cos-agent/.env` });
// notifications/.env ANTES de apps.env a propósito: NOTIF_BOT_TOKEN vive nativamente en
// ~/.claude/notifications/.env (es la config propia del bot @ClaudeCalbot — ver
// ~/Claude Projects/telegram-reference.md), y apps.env solo tiene una COPIA para que loaders
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
import { makeResearchCompetenciaCookiesProvider } from "../src/tools/research-competencia-cookies.js";
import { sendNotifySummary, wantsNoNotify } from "./research-competencia-notify.js";
import { findMissingEnvVars, formatMissingEnvError } from "./research-competencia-env.js";

/**
 * Corre el research de competencia fuera del daemon de Jano — ya no vive ahí, corre standalone
 * disparado por un cron externo de launchd (el plist se crea/mantiene aparte, fuera de este repo).
 * `npm run research:now -- --timeframe=14 --entidades=takenos,meru [--no-notify]`
 *
 * ⚠️ Requiere Full Disk Access para leer la sesión de Safari (Cookies.binarycookies) —
 * `makeResearchCompetenciaCookiesProvider` (research-competencia-cookies.ts) lee el archivo
 * DIRECTO, sin pasar por el Cookie Broker. Sin FDA, la lectura falla en silencio (queda logueada
 * como `research_competencia_cookies_read_failed`) y el scraping social corre sin sesión —
 * síntoma no obvio: el research "funciona" pero cada red social devuelve el muro de login (por
 * eso `formatSummaryHtml` en research-competencia.ts agrega una advertencia explícita cuando la
 * corrida entera obtuvo 0 cookies — ver el comentario ahí). El FDA está atado al binario
 * `~/.claude/bin/node-fda`, no a "node" en general — un `npm run` normal arranca el `node` del
 * PATH y lo pierde en silencio. Por eso `research:now` (package.json) invoca
 * `node-fda --import tsx/esm scripts/research-competencia-now.ts` en vez de `tsx` directo: `tsx`
 * (el CLI) es en sí un script Node que puede re-exec un subproceso con otras flags, y no hay
 * garantía de que ese subproceso conserve la identidad de `node-fda` — mismo riesgo que perder el
 * FDA vía `npm run`. `--import tsx/esm` es el loader ESM que el propio paquete `tsx` documenta
 * para exactamente este caso (Node 22+, ya lo exige `engines` del repo): es UN SOLO proceso
 * `node-fda`, sin subproceso intermedio, así que el permiso nunca se pierde. Verificado en este
 * entorno: `node-fda --import tsx/esm archivo.ts` corre y tipa TypeScript sin pasar por el CLI de
 * tsx. Precedente del repo (`cookie-jar.ts`, `sync-safari-cookies.mjs`) invoca `node-fda` contra
 * `.mjs` plano, no contra TypeScript — no había un patrón ya validado para `node-fda` + TS, así
 * que esto es la resolución nueva, no una copia de uno existente.
 *
 * Ya NO hace falta `op run`: sin el Cookie Broker (Cloudflare KV) de por medio, las únicas
 * credenciales que este script necesita (OPENROUTER_API_KEY, ELEVENLABS_API_KEY,
 * NOTIF_BOT_TOKEN) ya llegan en texto plano por los `loadEnv()` de arriba — validadas al arranque
 * más abajo (`findMissingEnvVars`), para fallar fuerte y temprano en vez de a mitad de camino:
 * Jano ya migró a 1Password, y el día que se limpie apps.env este script se rompería en silencio
 * (vision.ts/whisper.ts tragan el error tool-por-tool y el informe sale incompleto sin avisar).
 */
async function main(): Promise<void> {
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

  const getCookies = makeResearchCompetenciaCookiesProvider();

  console.log("Corriendo research de competencia... (puede tardar entre 10 y 45 minutos)");
  const result = await runResearchCompetencia({ timeframeDias, entidadIds, getCookies });
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

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
