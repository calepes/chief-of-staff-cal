// task-store.ts — propuestas de tarea vivas + input pendiente, en CF KV.
// Espejo de learning-store.ts / journal-store.ts.

import type { CfKv } from "../cf-kv.js";
import type { TaskPendingInput, TaskProposal } from "./task-types.js";

/**
 * 7 días. Con "crear al confirmar" (decisión de Cal, 2026-07-28) una propuesta sin tocar es una
 * tarea que nunca nace, así que la ventana es deliberadamente larga; el mail además NO se archiva
 * hasta que la tarea se crea, así que la inbox queda como respaldo.
 */
const PROPOSAL_TTL_SEC = 7 * 24 * 3600;

/**
 * 10 min para el texto libre. Corto a propósito: mientras está vivo, un mensaje de Cal que
 * parsee como fecha/persona se consume acá en vez de ir al agente. El modo journal ya se tragó
 * un pedido real por tener una ventana larga (2h) — ver CLAUDE.md.
 *
 * Mínimo de CF KV: 60s. Nunca bajar de ahí: un TTL menor devuelve 400 y rompe el flujo entero
 * en silencio (gotcha ya pagado con MEETING_FLOW_LOCK_TTL_SEC).
 */
const INPUT_TTL_SEC = 600;

export class TaskStore {
  constructor(private kv: CfKv) {}

  private proposalKey(chatId: number, proposalId: string): string {
    return `jano:task:proposal:${chatId}:${proposalId}`;
  }

  private inputKey(chatId: number): string {
    return `jano:task:input:${chatId}`;
  }

  async createProposal(chatId: number, payload: TaskProposal): Promise<string> {
    const proposalId = Math.random().toString(36).slice(2, 10);
    await this.kv.set(this.proposalKey(chatId, proposalId), payload, PROPOSAL_TTL_SEC);
    return proposalId;
  }

  async getProposal(chatId: number, proposalId: string): Promise<TaskProposal | null> {
    return await this.kv.get<TaskProposal>(this.proposalKey(chatId, proposalId));
  }

  async updateProposal(chatId: number, proposalId: string, payload: TaskProposal): Promise<void> {
    await this.kv.set(this.proposalKey(chatId, proposalId), payload, PROPOSAL_TTL_SEC);
  }

  async clearProposal(chatId: number, proposalId: string): Promise<void> {
    await this.kv.delete(this.proposalKey(chatId, proposalId));
  }

  async setPendingInput(chatId: number, value: TaskPendingInput): Promise<void> {
    await this.kv.set(this.inputKey(chatId), value, INPUT_TTL_SEC);
  }

  async getPendingInput(chatId: number): Promise<TaskPendingInput | null> {
    return await this.kv.get<TaskPendingInput>(this.inputKey(chatId));
  }

  async clearPendingInput(chatId: number): Promise<void> {
    await this.kv.delete(this.inputKey(chatId));
  }
}
