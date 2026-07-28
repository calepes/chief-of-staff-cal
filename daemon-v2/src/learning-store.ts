// learning-store.ts — batches del pase nocturno de self-learning en CF KV.
// Espejo reducido de journal-store.ts.

import type { CfKv } from "./cf-kv.js";
import type { LearningBatch } from "./learning-types.js";

/** 24h: el pase corre de noche y Cal puede tocar los botones recién a la mañana. */
const BATCH_TTL_SEC = 86400;

export class LearningStore {
  constructor(private kv: CfKv) {}

  private batchKey(chatId: number, batchId: string): string {
    return `jano:learning:batch:${chatId}:${batchId}`;
  }

  async createBatch(chatId: number, payload: LearningBatch): Promise<string> {
    const batchId = Math.random().toString(36).slice(2, 10);
    await this.kv.set(this.batchKey(chatId, batchId), payload, BATCH_TTL_SEC);
    return batchId;
  }

  async getBatch(chatId: number, batchId: string): Promise<LearningBatch | null> {
    return await this.kv.get<LearningBatch>(this.batchKey(chatId, batchId));
  }

  async updateBatch(chatId: number, batchId: string, payload: LearningBatch): Promise<void> {
    await this.kv.set(this.batchKey(chatId, batchId), payload, BATCH_TTL_SEC);
  }

  async clearBatch(chatId: number, batchId: string): Promise<void> {
    await this.kv.delete(this.batchKey(chatId, batchId));
  }
}
