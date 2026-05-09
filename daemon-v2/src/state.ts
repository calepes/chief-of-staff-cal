import type { CfKv } from "./cf-kv.js";

export type MessageRole = "user" | "assistant" | "summary";

export interface ConversationMessage {
  role: MessageRole;
  content: string;
}

export type Compactor = (msgs: ConversationMessage[]) => Promise<string>;

const TTL_SECONDS = 43200;
const MAX_MESSAGES = 40;
const COMPACT_WINDOW = 20;

export class ConversationState {
  constructor(
    private kv: CfKv,
    private compact?: Compactor,
  ) {}

  private key(chatId: number): string {
    return `cos-ctx:${chatId}`;
  }

  async load(chatId: number): Promise<ConversationMessage[]> {
    return (await this.kv.get<ConversationMessage[]>(this.key(chatId))) ?? [];
  }

  async append(chatId: number, msg: ConversationMessage): Promise<void> {
    const current = await this.load(chatId);

    if (current.length >= MAX_MESSAGES && this.compact) {
      const nonSummary = current.filter((m) => m.role !== "summary");
      const toCompact = nonSummary.slice(0, COMPACT_WINDOW);
      const rest = nonSummary.slice(COMPACT_WINDOW);
      try {
        const summaryText = await this.compact(toCompact);
        await this.kv.set(
          this.key(chatId),
          [{ role: "summary", content: summaryText }, ...rest, msg],
          TTL_SECONDS,
        );
      } catch {
        await this.kv.set(
          this.key(chatId),
          [...nonSummary.slice(-COMPACT_WINDOW), msg],
          TTL_SECONDS,
        );
      }
      return;
    }

    await this.kv.set(this.key(chatId), [...current, msg].slice(-MAX_MESSAGES), TTL_SECONDS);
  }

  async clear(chatId: number): Promise<void> {
    await this.kv.delete(this.key(chatId));
  }
}
