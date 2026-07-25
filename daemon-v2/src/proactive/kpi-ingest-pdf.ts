import { parseNumber, normalizeDate } from "./kpi-ingest-csv.js";

export interface PdfKpiFields {
  afiliacionesDiarias: number | null;
  afiliados7d: number | null;
  trx: number | null;
  trxPromedio7d: number | null;
  activosDau: number | null;
  afiliacionesVsAyer: number | null;
  afiliacionesVsSemana: number | null;
  trxVsAyer: number | null;
  trxVsSemana: number | null;
  dauVsAyer: number | null;
  dauVsSemana: number | null;
}

type ValueKey = "afiliacionesDiarias" | "afiliados7d" | "trx" | "trxPromedio7d" | "activosDau";

// Match exacto de línea completa — evita falsos positivos con las etiquetas de gráficos
// ("Afiliaciones diarias\tAfiliaciones (Prom. 7d)") que comparten el mismo texto como prefijo.
const VALUE_LABELS: Record<string, ValueKey> = {
  "Afiliaciones diarias": "afiliacionesDiarias",
  "Afiliados 7d": "afiliados7d",
  "TRX": "trx",
  "TRX Promedio 7d": "trxPromedio7d",
  "Activos DAU": "activosDau",
};

const VS_AYER_KEY: Partial<Record<ValueKey, keyof PdfKpiFields>> = {
  afiliacionesDiarias: "afiliacionesVsAyer",
  trx: "trxVsAyer",
  activosDau: "dauVsAyer",
};
const VS_SEMANA_KEY: Partial<Record<ValueKey, keyof PdfKpiFields>> = {
  afiliacionesDiarias: "afiliacionesVsSemana",
  trx: "trxVsSemana",
  activosDau: "dauVsSemana",
};

const LOOKAHEAD = 5;

function parseArrowPercent(line: string): number | null {
  const m = /([+-]?\d+(?:[.,]\d+)?)\s*%/.exec(line);
  if (!m) return null;
  return Number(m[1].replace(",", ".")) / 100;
}

/**
 * Extrae los KPIs del texto plano del PDF "Seguimiento Diario Yape Bolivia".
 * Formato real (verificado contra un PDF real 2026-07-23): cada bloque es
 * "{Etiqueta}\n{valor}\nvs. Día anterior : {flecha} {signo}{pct}%\nvs. Sem. anterior : ...".
 * Nota: el reporte real trae un typo ("vs. Sem. anteior", sin r) en el bloque de "Afiliados 7d" —
 * por eso el match de la línea vs.-Sem. es por prefijo ("vs. Sem.") y no exige "anterior" completo.
 */
export function extractPdfKpis(text: string): PdfKpiFields {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const result: PdfKpiFields = {
    afiliacionesDiarias: null,
    afiliados7d: null,
    trx: null,
    trxPromedio7d: null,
    activosDau: null,
    afiliacionesVsAyer: null,
    afiliacionesVsSemana: null,
    trxVsAyer: null,
    trxVsSemana: null,
    dauVsAyer: null,
    dauVsSemana: null,
  };

  for (let i = 0; i < lines.length; i++) {
    const key = VALUE_LABELS[lines[i]];
    if (!key || result[key] != null) continue;
    const num = parseNumber(lines[i + 1] ?? "");
    if (num === null) continue;
    result[key] = num;

    const ayerKey = VS_AYER_KEY[key];
    const semKey = VS_SEMANA_KEY[key];
    for (let j = i + 2; j < Math.min(i + 2 + LOOKAHEAD, lines.length); j++) {
      if (VALUE_LABELS[lines[j]]) break; // llegamos al bloque siguiente, no seguir leyendo
      if (ayerKey && result[ayerKey] == null && /^vs\.\s*D[ií]a\s*anterior/i.test(lines[j])) {
        result[ayerKey] = parseArrowPercent(lines[j]);
      } else if (semKey && result[semKey] == null && /^vs\.\s*Sem\./i.test(lines[j])) {
        result[semKey] = parseArrowPercent(lines[j]);
      }
    }
  }

  return result;
}

export function isFailedReport(text: string): boolean {
  return /updated\s*fail/i.test(text);
}

/** Filename real: "Seguimiento Diario Yape | 22/07/2026.PDF" */
export function parseReportDateFromFilename(filename: string): string | null {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(filename);
  if (!m) return null;
  return normalizeDate(m[0]);
}
