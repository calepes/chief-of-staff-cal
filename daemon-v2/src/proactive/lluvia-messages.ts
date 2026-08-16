// lluvia-messages.ts — construcción PURA de los 3 mensajes diarios de lluvia (reporte,
// confirmación del cron, alerta). Separado de lluvia-check.ts (que hace el fetch real +
// KV + envío) para que esta lógica de branching sea testeable sin mockear fetch/CfKv —
// mismo motivo por el que journal-text.ts/task-dates.ts están separados de sus
// orquestadores en este repo.

export interface CiudadDiaResultado {
  ciudad: string;
  ok: boolean; // false = el fetch mismo falló (red, HTTP error)
  total: number | null; // null = sin dato para la fecha pedida (aunque el fetch haya sido ok)
  categoria?: string | null; // Poca/Normal/Considerable/Fuerte/Excepcional, de contexto.etiqueta
  percentil?: number | null;
  maxHist?: number | null;
  error?: string;
}

export interface LluviaMessages {
  reporte: string;
  confirmacion: string;
  alerta: string | null;
}

// Umbral acordado con Cal: desde "Considerable" en adelante (p75+), no solo Fuerte/Excepcional.
const UMBRAL_ALERTA = new Set(["Considerable", "Fuerte", "Excepcional"]);

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildLluviaMessages(fecha: string, resultados: CiudadDiaResultado[]): LluviaMessages {
  return {
    reporte: buildReporte(fecha, resultados),
    confirmacion: buildConfirmacion(fecha, resultados),
    alerta: buildAlerta(fecha, resultados),
  };
}

function buildReporte(fecha: string, resultados: CiudadDiaResultado[]): string {
  const filas = resultados
    .map((r) => {
      const mm = r.total != null ? `${r.total} mm` : "sin dato";
      const cat = r.categoria ? ` (${escapeHtml(r.categoria)})` : "";
      return `<tr><td>${escapeHtml(r.ciudad)}</td><td>${mm}${cat}</td></tr>`;
    })
    .join("");
  return `<b>🌧️ Lluvia de hoy (${fecha})</b>\n<table><tr><th>Ciudad</th><th>Total</th></tr>${filas}</table>`;
}

function buildConfirmacion(fecha: string, resultados: CiudadDiaResultado[]): string {
  const faltantes = resultados.filter((r) => !r.ok || r.total == null);
  if (faltantes.length === 0) {
    return `✅ Cron de lluvia OK (${fecha}) — las ${resultados.length} ciudades cargaron.`;
  }
  const detalle = faltantes
    .map((r) => `${escapeHtml(r.ciudad)}${r.error ? ` (${escapeHtml(r.error)})` : " (sin dato de hoy)"}`)
    .join(", ");
  return `⚠️ Cron de lluvia con problemas (${fecha}): ${detalle}. Revisa cron.log en la Mac.`;
}

function buildAlerta(fecha: string, resultados: CiudadDiaResultado[]): string | null {
  const disparadas = resultados.filter((r) => r.categoria && UMBRAL_ALERTA.has(r.categoria));
  if (disparadas.length === 0) return null;
  const lineas = disparadas
    .map((r) => {
      const pct = r.percentil != null ? ` (percentil ${r.percentil})` : "";
      return `• <b>${escapeHtml(r.ciudad)}</b>: ${r.total} mm — ${escapeHtml(r.categoria ?? "")}${pct}`;
    })
    .join("\n");
  return `🌧️ <b>Lluvia inusual hoy (${fecha})</b>\n${lineas}`;
}
