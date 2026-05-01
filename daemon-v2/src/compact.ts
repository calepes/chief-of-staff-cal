import { startup } from "@anthropic-ai/claude-agent-sdk";
import type { ConversationMessage } from "./state.js";

export async function compactHistory(msgs: ConversationMessage[]): Promise<string> {
  const handle = await startup({
    options: {
      model: "claude-haiku-4-5-20251001",
      maxTurns: 1,
      allowedTools: [],
    },
  });

  const transcript = msgs
    .filter((m) => m.role !== "summary")
    .map((m) => `${m.role === "user" ? "Cal" : "CoS"}: ${m.content}`)
    .join("\n");

  let summary = "";
  for await (const event of handle.query(
    `Resume esta conversación en máximo 150 palabras. Usa bullets cortos. ` +
    `Incluye: decisiones tomadas, temas tratados, entidades mencionadas ` +
    `(nombres, cifras, proyectos), y contexto que el asistente necesite ` +
    `para continuar coherentemente.\n\n${transcript}`,
  )) {
    if (
      (event as { type?: string }).type === "result" &&
      (event as { subtype?: string }).subtype === "success"
    ) {
      summary = (event as { result?: string }).result ?? "";
      break;
    }
  }

  return summary.trim() || "(sin resumen)";
}
