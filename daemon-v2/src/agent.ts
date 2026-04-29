import type { WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import type { ConversationMessage } from "./state.js";

export interface AgentDeps {
  warm: WarmQuery;
  history: ConversationMessage[];
  contextHeader?: string;
}

export interface AgentResult {
  reply: string;
  sdkMs: number;
  firstEventMs: number;
}

export async function runAgent(userMessage: string, deps: AgentDeps): Promise<AgentResult> {
  const historyBlock = deps.history.length
    ? deps.history.map((m) => `${m.role === "user" ? "Cal" : "CoS"}: ${m.content}`).join("\n")
    : "";

  const prompt = [
    deps.contextHeader && deps.contextHeader,
    historyBlock && `Historial reciente:\n${historyBlock}`,
    `Mensaje: ${userMessage}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const sdkStart = Date.now();
  const q = deps.warm.query(prompt);
  let firstEventMs = 0;
  let finalText = "";
  const toolCalls: Array<{ name: string; ok?: boolean; err?: string }> = [];

  for await (const message of q) {
    if (firstEventMs === 0) firstEventMs = Date.now() - sdkStart;

    if (message.type === "assistant") {
      const content =
        (message as { message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> } })
          .message?.content ?? [];
      for (const block of content) {
        if (block.type === "tool_use" && block.name) {
          toolCalls.push({ name: block.name });
          console.log(JSON.stringify({ ts: Date.now(), msg: "tool_use", name: block.name, input: block.input }));
        }
      }
    } else if (message.type === "user") {
      const content =
        (message as {
          message?: { content?: Array<{ type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }> };
        }).message?.content ?? [];
      for (const block of content) {
        if (block.type === "tool_result") {
          const last = toolCalls[toolCalls.length - 1];
          if (last) {
            last.ok = !block.is_error;
            if (block.is_error) last.err = JSON.stringify(block.content).slice(0, 200);
          }
          console.log(
            JSON.stringify({
              ts: Date.now(),
              msg: "tool_result",
              is_error: block.is_error,
              content_preview: JSON.stringify(block.content).slice(0, 300),
            }),
          );
        }
      }
    }

    if (message.type === "result" && message.subtype === "success") {
      finalText = (message as { result?: string }).result ?? "";
      const modelUsage = (
        message as {
          modelUsage?: Record<
            string,
            {
              inputTokens?: number;
              outputTokens?: number;
              cacheReadInputTokens?: number;
              cacheCreationInputTokens?: number;
              costUSD?: number;
            }
          >;
        }
      ).modelUsage;
      if (modelUsage) {
        console.log(JSON.stringify({ ts: Date.now(), msg: "usage", modelUsage }));
      }
      break;
    }
  }

  console.log(JSON.stringify({ ts: Date.now(), msg: "turn_summary", toolCalls }));

  return {
    reply: finalText.trim() || "(sin respuesta)",
    sdkMs: Date.now() - sdkStart,
    firstEventMs,
  };
}
