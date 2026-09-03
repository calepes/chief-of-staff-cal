import { config as loadEnv } from "dotenv";
loadEnv({ path: `${process.env.HOME}/.cos-agent/.env` });
loadEnv({ path: `${process.env.HOME}/.claude/secrets/apps.env` });
loadEnv({ path: `${process.env.HOME}/.claude/notifications/.env` });

// Fuerza auth OAuth Max (Keychain) — sin esto, si hay una API key de Tier 1 en el
// entorno, el SDK la usa y tira 429. index.ts hace esto una vez por el daemon;
// este script es un proceso aparte, así que lo repite acá.
delete process.env.ANTHROPIC_API_KEY;

import { runResearchCompetencia, formatSummaryHtml } from "../src/tools/research-competencia.js";
import { stripHtmlTags } from "../src/proactive/rich-send.js";
import { makeResearchCompetenciaCookiesProvider } from "../src/tools/research-competencia-cookies.js";
import { sendNotifySummary, wantsNoNotify } from "./research-competencia-notify.js";

/**
 * Corre el research de competencia fuera del daemon de Jano (ya no vive ahí — cron externo de
 * launchd, ver docs/superpowers/ sobre la salida del research del daemon).
 * `npm run research:now -- --timeframe=14 --entidades=takenos,meru [--no-notify]`
 *
 * ⚠️ Requiere Full Disk Access para leer la sesión de Safari (Cookies.binarycookies) —
 * `makeResearchCompetenciaCookiesProvider` (research-competencia-cookies.ts) lee el archivo
 * DIRECTO, sin pasar por el Cookie Broker. Sin FDA, la lectura falla en silencio (queda logueada
 * como `research_competencia_cookies_read_failed`) y el scraping social corre sin sesión —
 * síntoma no obvio: el research "funciona" pero cada red social devuelve el muro de login. Correr
 * con el binario que ya tiene el permiso otorgado: `~/.claude/bin/node-fda`, ej.
 * `~/.claude/bin/node-fda $(which tsx) scripts/research-competencia-now.ts`. Ya NO hace falta
 * `op run`: sin el Cookie Broker (Cloudflare KV) de por medio, las únicas credenciales que este
 * script necesita (OPENROUTER_API_KEY, ELEVENLABS_API_KEY, NOTIF_BOT_TOKEN) ya llegan en texto
 * plano por los `loadEnv()` de arriba.
 */
async function main(): Promise<void> {
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
