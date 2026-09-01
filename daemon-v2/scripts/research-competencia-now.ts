// Fuerza auth OAuth Max (Keychain) — sin esto, si hay una API key de Tier 1 en el
// entorno, el SDK la usa y tira 429. index.ts hace esto una vez por el daemon;
// este script es un proceso aparte, así que lo repite acá.
delete process.env.ANTHROPIC_API_KEY;

import { runResearchCompetencia, formatSummaryHtml } from "../src/tools/research-competencia.js";
import { stripHtmlTags } from "../src/proactive/rich-send.js";

/**
 * Corre el research de competencia fuera del cron semanal (lunes 7am).
 * `npm run research:now -- --timeframe=14 --entidades=takenos,meru`
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const timeframeArg = args.find((a) => a.startsWith("--timeframe="));
  const entidadesArg = args.find((a) => a.startsWith("--entidades="));
  const timeframeDiasRaw = timeframeArg ? Number(timeframeArg.split("=")[1]) : undefined;
  const timeframeDias = Number.isFinite(timeframeDiasRaw) ? timeframeDiasRaw : undefined;
  const entidadIds = entidadesArg ? entidadesArg.split("=")[1].split(",").map((s) => s.trim()) : undefined;

  console.log("Corriendo research de competencia... (puede tardar 1-3 minutos)");
  const result = await runResearchCompetencia({ timeframeDias, entidadIds });
  console.log(stripHtmlTags(formatSummaryHtml(result)));
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
