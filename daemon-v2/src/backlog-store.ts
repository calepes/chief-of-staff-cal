// backlog-store.ts — propuestas de backlog pendientes de confirmación, en CF KV.
// Espejo reducido de journal-store.ts (que a su vez espeja proposal-store.ts de Pecunia).

import type { CfKv } from "./cf-kv.js";
import type { BacklogProposal } from "./backlog-types.js";

/** 1 hora: Cal puede dictar una idea y tocar el botón un rato después. */
const PROPOSAL_TTL_SEC = 3600;

export class BacklogStore {
  constructor(private kv: CfKv) {}

  private propKey(chatId: number, shortId: string): string {
    return `jano:backlog:prop:${chatId}:${shortId}`;
  }

  /** shortId de 8 chars: `bklg:destpick:{8}:{key}` queda holgado bajo los 64 bytes de Telegram. */
  async createProposal(chatId: number, payload: BacklogProposal): Promise<string> {
    const shortId = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
    await this.kv.set(this.propKey(chatId, shortId), payload, PROPOSAL_TTL_SEC);
    return shortId;
  }

  async getProposal(chatId: number, shortId: string): Promise<BacklogProposal | null> {
    return await this.kv.get<BacklogProposal>(this.propKey(chatId, shortId));
  }

  async updateProposal(chatId: number, shortId: string, payload: BacklogProposal): Promise<void> {
    await this.kv.set(this.propKey(chatId, shortId), payload, PROPOSAL_TTL_SEC);
  }

  async clearProposal(chatId: number, shortId: string): Promise<void> {
    await this.kv.delete(this.propKey(chatId, shortId));
  }
}
