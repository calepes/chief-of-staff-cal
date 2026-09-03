import { runResearchCompetencia, formatSummaryHtml } from "../tools/research-competencia.js";
import { sendCronMessage } from "./rich-send.js";
import type { StructuredCookie } from "../tools/cookie-jar.js";

export interface ResearchCompetenciaWeeklyOpts {
  botToken: string;
  chatId: number;
  /** Proveedor de cookies del Cookie Broker. Sin él, el scraping social corre sin sesión. */
  getCookies?: (hostname: string) => Promise<StructuredCookie[]>;
}

export async function checkResearchCompetenciaWeekly(opts: ResearchCompetenciaWeeklyOpts): Promise<void> {
  let result;
  try {
    result = await runResearchCompetencia({ timeframeDias: 7, getCookies: opts.getCookies });
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_weekly_run_failed", err: String(err) }));
    return;
  }

  try {
    await sendCronMessage(opts.botToken, { chatId: opts.chatId, text: formatSummaryHtml(result) });
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_weekly_sent", totalHallazgos: result.totalHallazgos }));
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_weekly_send_failed", err: String(err) }));
  }
}
