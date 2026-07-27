// journal-store.ts — propuestas, snapshots de undo y estado del modo journal en CF KV.
// Espejo de `proposal-store.ts` de Pecunia (pecunia-agent/daemon/src/proposal-store.ts).

import type { CfKv } from "./cf-kv.js";
import type { JournalMode, JournalProposal, JournalUndo, PendingEdit } from "./journal-types.js";

/** 1 hora: Cal journalea de noche y puede tardar en tocar los botones. */
const PROPOSAL_TTL_SEC = 3600;
/** 10 min de ventana para deshacer, igual que Pecunia. */
const UNDO_TTL_SEC = 600;
/**
 * 30 min: si el modo queda abierto por olvido, expira solo.
 * Bajado de 2h el 2026-07-27, el primer día de uso — con la ventana larga un pedido
 * real de Cal ("Dame el último card de lending") se guardó como pensamiento en vez
 * de responderse. Una descarga de journal es una ráfaga de minutos, no de horas.
 * Cada guardado refresca el TTL (`bumpMode`), así que una sesión larga no se corta.
 */
const MODE_TTL_SEC = 1800;

export class JournalStore {
  constructor(private kv: CfKv) {}

  private propKey(chatId: number, shortId: string): string {
    return `jano:journal:prop:${chatId}:${shortId}`;
  }

  private undoKey(chatId: number, entryId: string): string {
    return `jano:journal:undo:${chatId}:${entryId}`;
  }

  private modeKey(chatId: number): string {
    return `jano:journal-mode:${chatId}`;
  }

  private editKey(chatId: number): string {
    return `jano:journal:edit:${chatId}`;
  }

  async createProposal(chatId: number, payload: JournalProposal): Promise<string> {
    const shortId = Math.random().toString(36).slice(2, 10);
    await this.kv.set(this.propKey(chatId, shortId), payload, PROPOSAL_TTL_SEC);
    return shortId;
  }

  async getProposal(chatId: number, shortId: string): Promise<JournalProposal | null> {
    return await this.kv.get<JournalProposal>(this.propKey(chatId, shortId));
  }

  /** Reemplaza el payload conservando el mismo shortId (pickers que mutan la propuesta). */
  async updateProposal(chatId: number, shortId: string, payload: JournalProposal): Promise<void> {
    await this.kv.set(this.propKey(chatId, shortId), payload, PROPOSAL_TTL_SEC);
  }

  async clearProposal(chatId: number, shortId: string): Promise<void> {
    await this.kv.delete(this.propKey(chatId, shortId));
  }

  async setUndo(chatId: number, entryId: string, snapshot: JournalUndo): Promise<void> {
    await this.kv.set(this.undoKey(chatId, entryId), snapshot, UNDO_TTL_SEC);
  }

  async getUndo(chatId: number, entryId: string): Promise<JournalUndo | null> {
    return await this.kv.get<JournalUndo>(this.undoKey(chatId, entryId));
  }

  async clearUndo(chatId: number, entryId: string): Promise<void> {
    await this.kv.delete(this.undoKey(chatId, entryId));
  }

  async openMode(chatId: number, mode: JournalMode): Promise<void> {
    await this.kv.set(this.modeKey(chatId), mode, MODE_TTL_SEC);
  }

  async getMode(chatId: number): Promise<JournalMode | null> {
    return await this.kv.get<JournalMode>(this.modeKey(chatId));
  }

  /** Suma a los contadores y refresca el TTL. No-op si el modo ya expiró. */
  async bumpMode(chatId: number, delta: { guardadas: number; pendientes: number }): Promise<void> {
    const mode = await this.getMode(chatId);
    if (!mode) return;
    await this.openMode(chatId, {
      ...mode,
      guardadas: mode.guardadas + delta.guardadas,
      pendientes: mode.pendientes + delta.pendientes,
    });
  }

  async closeMode(chatId: number): Promise<void> {
    await this.kv.delete(this.modeKey(chatId));
  }

  /** Marca que la PRÓXIMA respuesta de texto de Cal es la edición de un campo. */
  async setPendingEdit(chatId: number, pending: PendingEdit): Promise<void> {
    await this.kv.set(this.editKey(chatId), pending, UNDO_TTL_SEC);
  }

  async getPendingEdit(chatId: number): Promise<PendingEdit | null> {
    return await this.kv.get<PendingEdit>(this.editKey(chatId));
  }

  async clearPendingEdit(chatId: number): Promise<void> {
    await this.kv.delete(this.editKey(chatId));
  }
}
