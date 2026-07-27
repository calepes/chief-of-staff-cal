import { parseNumber, normalizeDate } from "./kpi-ingest-csv.js";

export interface LendingFunnelFields {
  leads: number | null;
  vistos: number | null;
  noVistos: number | null;
  meInteresa: number | null;
  noMeInteresa: number | null;
  sinInteraccion: number | null;
  contactado: number | null;
  noContactado: number | null;
  derivados: number | null;
  noDerivados: number | null;
  enProcesoDerivados: number | null; // rama Derivados → Agencia
  agencia: number | null;
  desembolso: number | null;
  enProcesoAgencia: number | null; // rama Agencia → Desembolso
  rechazado: number | null;
}

type SimpleKey = Exclude<keyof LendingFunnelFields, "enProcesoDerivados" | "enProcesoAgencia">;

// Match por label normalizada (sin tildes, mayúsculas) al FINAL de la línea — no exige que la
// línea sea EXACTAMENTE la label porque pdf-parse a veces pega el porcentaje del bloque anterior
// justo antes de la label siguiente sin salto de línea real (visto en 3 de 4 PDFs reales:
// "27,1 %NO DERIVADOS" en una sola línea). Se acepta el match "pegado" solo si lo que queda antes
// de la label (`residue`) es puramente numérico/porcentaje — así "NO VISTOS" nunca matchea la
// label "VISTOS" (el residuo "NO " tiene letras, se rechaza).
const SIMPLE_LABELS: Record<string, SimpleKey> = {
  LEADS: "leads",
  VISTOS: "vistos",
  "NO VISTOS": "noVistos",
  "ME INTERESA": "meInteresa",
  "NO ME INTERESA": "noMeInteresa",
  "SIN INTERACCION": "sinInteraccion",
  CONTACTADO: "contactado",
  "NO CONTACTADO": "noContactado",
  DERIVADOS: "derivados",
  "NO DERIVADOS": "noDerivados",
  AGENCIA: "agencia",
  DESEMBOLSO: "desembolso",
  RECHAZADO: "rechazado",
};

const EN_PROCESO_LABEL = "EN PROCESO";

// Rama resuelta según la última label simple vista antes del "EN PROCESO" (ancla de contexto,
// no orden ordinal — más robusto si Power BI reordena secciones).
const EN_PROCESO_BRANCH_BY_ANCHOR: Partial<Record<SimpleKey, "enProcesoAgencia" | "enProcesoDerivados">> = {
  desembolso: "enProcesoAgencia",
  derivados: "enProcesoDerivados",
};

const DIACRITICS_RANGE_START = 0x0300;
const DIACRITICS_RANGE_END = 0x036f;

function normalizeLabel(s: string): string {
  const stripped = Array.from(s.normalize("NFD"))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < DIACRITICS_RANGE_START || code > DIACRITICS_RANGE_END;
    })
    .join("");
  return stripped.trim().toUpperCase();
}

const NUMERIC_RESIDUE = /^[\d.,\s%]*$/;

/** Si `line` es exactamente `label`, o termina en `label` con un residuo puramente numérico/%
 * antes (el caso "pegado"), devuelve ese residuo (""  si fue match exacto). null si no matchea. */
function matchLabelSuffix(line: string, label: string): string | null {
  const normLine = normalizeLabel(line);
  if (normLine === label) return "";
  if (normLine.endsWith(label)) {
    const residue = normLine.slice(0, normLine.length - label.length);
    if (residue.trim() !== "" && NUMERIC_RESIDUE.test(residue)) return residue;
  }
  return null;
}

export interface LendingParseIssue {
  campo: string;
  motivo: string;
}

export interface LendingExtractResult {
  fields: LendingFunnelFields;
  issues: LendingParseIssue[];
}

/**
 * Extrae los 15 nodos del funnel "Funnel Piloto Yape Lending". El valor de cada label vive
 * siempre en `lines[i+1]` (no hay lookahead de vs.Ayer/vs.Semana como en el PDF de Seguimiento
 * Diario — este reporte no los trae). Los porcentajes del PDF NO se parsean: su posición es
 * inconsistente entre bloques y no aportan nada al schema — la integridad se valida 100% con
 * `reconcileLendingFunnel()`.
 */
export function extractLendingFunnel(text: string): LendingExtractResult {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const fields: LendingFunnelFields = {
    leads: null,
    vistos: null,
    noVistos: null,
    meInteresa: null,
    noMeInteresa: null,
    sinInteraccion: null,
    contactado: null,
    noContactado: null,
    derivados: null,
    noDerivados: null,
    enProcesoDerivados: null,
    agencia: null,
    desembolso: null,
    enProcesoAgencia: null,
    rechazado: null,
  };
  const issues: LendingParseIssue[] = [];

  let lastAnchor: SimpleKey | null = null;
  let enProcesoCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue;

    let matchedSimple: SimpleKey | null = null;
    for (const [label, key] of Object.entries(SIMPLE_LABELS)) {
      if (matchLabelSuffix(line, label) !== null) {
        matchedSimple = key;
        break;
      }
    }
    if (matchedSimple) {
      if (fields[matchedSimple] != null) continue; // ya resuelto, no pisar con un match tardío
      const num = parseNumber(lines[i + 1] ?? "");
      if (num === null) {
        issues.push({ campo: matchedSimple, motivo: `no pude leer el valor tras la label en línea ${i}` });
      } else {
        fields[matchedSimple] = num;
      }
      lastAnchor = matchedSimple;
      continue;
    }

    if (matchLabelSuffix(line, EN_PROCESO_LABEL) !== null) {
      enProcesoCount++;
      const branch = lastAnchor ? EN_PROCESO_BRANCH_BY_ANCHOR[lastAnchor] : undefined;
      if (!branch) {
        issues.push({ campo: "enProceso", motivo: `"EN PROCESO" sin ancla reconocible (línea ${i}, ancla previa: ${lastAnchor ?? "ninguna"})` });
        continue;
      }
      if (fields[branch] != null) {
        issues.push({ campo: branch, motivo: `"EN PROCESO" resuelto a una rama ya asignada (línea ${i})` });
        continue;
      }
      const num = parseNumber(lines[i + 1] ?? "");
      if (num === null) {
        issues.push({ campo: branch, motivo: `no pude leer el valor de "EN PROCESO" en línea ${i}` });
      } else {
        fields[branch] = num;
      }
    }
  }

  if (enProcesoCount !== 2) {
    issues.push({ campo: "enProceso", motivo: `esperaba 2 ocurrencias de "EN PROCESO", encontré ${enProcesoCount}` });
  }

  return { fields, issues };
}

export interface LendingReconcileResult {
  ok: boolean;
  errors: string[];
}

function checkSum(label: string, parts: Array<[string, number | null]>, total: number | null): string | null {
  if (total == null || parts.some(([, v]) => v == null)) {
    const faltantes = [...(total == null ? ["total"] : []), ...parts.filter(([, v]) => v == null).map(([n]) => n)];
    return `${label}: faltan campos (${faltantes.join(", ")})`;
  }
  const sum = parts.reduce((acc, [, v]) => acc + (v ?? 0), 0);
  if (sum !== total) return `${label}: ${parts.map(([n, v]) => `${n}(${v})`).join("+")} = ${sum} ≠ total ${total}`;
  return null;
}

/** 6 igualdades que cubren los 15 campos — verificadas contra 4 días reales (cierran exacto). */
export function reconcileLendingFunnel(f: LendingFunnelFields): LendingReconcileResult {
  const errors = [
    checkSum("Vistos+NoVistos=Leads", [["vistos", f.vistos], ["noVistos", f.noVistos]], f.leads),
    checkSum(
      "MeInteresa+NoMeInteresa+SinInteraccion=Vistos",
      [["meInteresa", f.meInteresa], ["noMeInteresa", f.noMeInteresa], ["sinInteraccion", f.sinInteraccion]],
      f.vistos,
    ),
    checkSum("Contactado+NoContactado=MeInteresa", [["contactado", f.contactado], ["noContactado", f.noContactado]], f.meInteresa),
    checkSum("Derivados+NoDerivados=Contactado", [["derivados", f.derivados], ["noDerivados", f.noDerivados]], f.contactado),
    checkSum("Agencia+EnProcesoDerivados=Derivados", [["agencia", f.agencia], ["enProcesoDerivados", f.enProcesoDerivados]], f.derivados),
    checkSum(
      "Desembolso+EnProcesoAgencia+Rechazado=Agencia",
      [["desembolso", f.desembolso], ["enProcesoAgencia", f.enProcesoAgencia], ["rechazado", f.rechazado]],
      f.agencia,
    ),
  ].filter((e): e is string => e !== null);

  return { ok: errors.length === 0, errors };
}

/** Fecha del CUERPO del email ("...cierre de la jornada de 2026-07-26..."). El PDF no trae fecha
 * en el filename (a diferencia de "Seguimiento Diario Yape | DD/MM/YYYY.PDF") ni es confiable
 * usar `internalDate` de recepción — el reporte del lunes cierra el domingo, no el propio día. */
export function parseReportDateFromBody(bodyText: string): string | null {
  const m = /cierre de la jornada de[:\s]+([\d/-]+)/i.exec(bodyText);
  if (!m) return null;
  return normalizeDate(m[1]);
}

export type LendingParseOutcome =
  | { ok: true; fields: LendingFunnelFields }
  | { ok: false; errors: string[] };

export function parseAndValidateLendingReport(text: string): LendingParseOutcome {
  const { fields, issues } = extractLendingFunnel(text);
  if (issues.length > 0) {
    return { ok: false, errors: issues.map((i) => `${i.campo}: ${i.motivo}`) };
  }
  const missing = (Object.entries(fields) as Array<[string, number | null]>).filter(([, v]) => v == null).map(([k]) => k);
  if (missing.length > 0) {
    return { ok: false, errors: [`campos faltantes: ${missing.join(", ")}`] };
  }
  const reconcile = reconcileLendingFunnel(fields);
  if (!reconcile.ok) {
    return { ok: false, errors: reconcile.errors };
  }
  return { ok: true, fields };
}
