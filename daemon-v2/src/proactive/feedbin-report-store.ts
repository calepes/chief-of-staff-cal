// feedbin-report-store.ts — estado del reporte diario de Feedbin en CF KV. Mismo patrón que
// learning-store.ts: un documento por corrida del cron, con TTL, para que el botón de "marcar
// leído" sepa qué IDs reales tocar sin mandarlos en el callback_data (límite de 64 bytes).

import type { CfKv } from "../cf-kv.js";
import type { FeedbinReportButton } from "./feedbin-report-card.js";

/** Todo lo necesario para reconstruir el mensaje completo tras un mark/undo.
 * `headerText` es la parte que NUNCA cambia (para abrir + resumen de carpetas) — solo
 * `buttons` se actualiza cuando Cal toca un botón. */
export interface FeedbinReportProposal {
  headerText: string;
  buttons: FeedbinReportButton[];
}

/** 7 días: si Cal no confirma hoy, el botón de un reporte viejo sigue siendo válido — marcar
 * como leído es idempotente del lado de Feedbin, así que no hace falta invalidar nada. */
const REPORT_TTL_SEC = 7 * 24 * 60 * 60;

export class FeedbinReportStore {
  constructor(private kv: CfKv) {}

  private key(reportId: string): string {
    return `jano:feedbin-report:${reportId}`;
  }

  async createReport(payload: FeedbinReportProposal): Promise<string> {
    const reportId = Math.random().toString(36).slice(2, 10);
    await this.kv.set(this.key(reportId), payload, REPORT_TTL_SEC);
    return reportId;
  }

  async getReport(reportId: string): Promise<FeedbinReportProposal | null> {
    return await this.kv.get<FeedbinReportProposal>(this.key(reportId));
  }

  async updateReport(reportId: string, payload: FeedbinReportProposal): Promise<void> {
    await this.kv.set(this.key(reportId), payload, REPORT_TTL_SEC);
  }
}
