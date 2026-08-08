// backlog-store.ts — propuestas de backlog pendientes de confirmación, y snapshots de undo,
// en CF KV. Espejo reducido de journal-store.ts (que a su vez espeja proposal-store.ts de Pecunia).

import type { CfKv } from "./cf-kv.js";
import type { BacklogProposal, BacklogUndo } from "./backlog-types.js";

/** 1 hora: Cal puede dictar una idea y tocar el botón un rato después. */
const PROPOSAL_TTL_SEC = 3600;
/** 10 min de ventana para deshacer, igual que Journal/Pecunia. */
const UNDO_TTL_SEC = 600;

export class BacklogStore {
  constructor(private kv: CfKv) {}

  private propKey(chatId: number, shortId: string): string {
    return `jano:backlog:prop:${chatId}:${shortId}`;
  }

  private undoKey(chatId: number, shortId: string): string {
    return `jano:backlog:undo:${chatId}:${shortId}`;
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

  /** Reusa el mismo shortId de la propuesta ya escrita — no hace falta un id propio. */
  async setUndo(chatId: number, shortId: string, snapshot: BacklogUndo): Promise<void> {
    await this.kv.set(this.undoKey(chatId, shortId), snapshot, UNDO_TTL_SEC);
  }

  async getUndo(chatId: number, shortId: string): Promise<BacklogUndo | null> {
    return await this.kv.get<BacklogUndo>(this.undoKey(chatId, shortId));
  }

  async clearUndo(chatId: number, shortId: string): Promise<void> {
    await this.kv.delete(this.undoKey(chatId, shortId));
  }
}
