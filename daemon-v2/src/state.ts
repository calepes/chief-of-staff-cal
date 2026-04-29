import type { CfKv } from "./cf-kv.js";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

const TTL_SECONDS = 600;
const MAX_MESSAGES = 10;

export class ConversationState {
  constructor(private kv: CfKv) {}

  private key(chatId: number): string {
    return `cos-ctx:${chatId}`;
  }

  async load(chatId: number): Promise<ConversationMessage[]> {
    return (await this.kv.get<ConversationMessage[]>(this.key(chatId))) ?? [];
  }

  async append(chatId: number, msg: ConversationMessage): Promise<void> {
    const current = await this.load(chatId);
    const next = [...current, msg].slice(-MAX_MESSAGES);
    await this.kv.set(this.key(chatId), next, TTL_SECONDS);
  }

  async clear(chatId: number): Promise<void> {
    await this.kv.delete(this.key(chatId));
  }
}
