import { runResearchCompetencia, formatSummaryHtml } from "../tools/research-competencia.js";
import { sendCronMessage } from "./rich-send.js";

export interface ResearchCompetenciaWeeklyOpts {
  botToken: string;
  chatId: number;
}

export async function checkResearchCompetenciaWeekly(opts: ResearchCompetenciaWeeklyOpts): Promise<void> {
  try {
    const result = await runResearchCompetencia({ timeframeDias: 7 });
    await sendCronMessage(opts.botToken, { chatId: opts.chatId, text: formatSummaryHtml(result) });
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_weekly_sent", totalHallazgos: result.totalHallazgos }));
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_weekly_failed", err: String(err) }));
  }
}
