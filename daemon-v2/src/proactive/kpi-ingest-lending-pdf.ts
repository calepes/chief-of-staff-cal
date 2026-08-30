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
  // Power BI renombró "LEADS" a "TOTAL" desde el reporte del 2026-08-19/20 (nuevo mini-funnel
  // resumen arriba del funnel principal, termina en "TOTAL" con el mismo valor que antes era
  // "Leads" — verificado: Vistos+NoVistos=TOTAL, igual que antes era Vistos+NoVistos=Leads).
  TOTAL: "leads",
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

// Power BI renombró la 2ª ocurrencia de "EN PROCESO" (rama Derivados→Agencia) a "SIN VISITA"
// desde el reporte del 2026-08-19/20 — verificado aritméticamente: Agencia+SinVisita=Derivados,
// igual que antes era Agencia+EnProceso(ancla derivados)=Derivados. Mapea DIRECTO a
// enProcesoDerivados (sin pasar por el mecanismo de ancla, que ya no aplica a esta label). La
// rama Agencia→Desembolso sigue llamándose "EN PROCESO" sin cambios.
const SIN_VISITA_LABEL = "SIN VISITA";

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

    if (matchLabelSuffix(line, SIN_VISITA_LABEL) !== null) {
      if (fields.enProcesoDerivados != null) continue; // ya resuelto (ej. por el "EN PROCESO" viejo)
      const num = parseNumber(lines[i + 1] ?? "");
      if (num === null) {
        issues.push({ campo: "enProcesoDerivados", motivo: `no pude leer el valor de "SIN VISITA" en línea ${i}` });
      } else {
        fields.enProcesoDerivados = num;
      }
      continue;
    }

    if (matchLabelSuffix(line, EN_PROCESO_LABEL) !== null) {
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

  // Ya no se cuentan ocurrencias de "EN PROCESO" (asumía siempre 2 — dejó de valer cuando Power BI
  // renombró una de las dos ramas a "SIN VISITA", ver arriba). Un branch sin resolver queda null y
  // lo atrapa el chequeo genérico de "campos faltantes" en parseAndValidateLendingReport() más
  // abajo — mismo mecanismo que cualquier otro campo del funnel, sin un caso especial acá.
  return { fields, issues };
}

export interface LendingReconcileResult {
  ok: boolean;
  errors: string[];
}

type FieldKey = keyof LendingFunnelFields;

interface FunnelEquation {
  label: string;
  parts: FieldKey[];
  total: FieldKey;
}

/** 6 igualdades que cubren los 15 campos — verificadas contra 4 días reales (cierran exacto).
 * Estructura compartida entre reconcileLendingFunnel() (valida) y deriveMissingField() (deduce
 * un campo faltante) — antes vivían duplicadas como 6 llamadas a checkSum() inline. */
const FUNNEL_EQUATIONS: FunnelEquation[] = [
  { label: "Vistos+NoVistos=Leads", parts: ["vistos", "noVistos"], total: "leads" },
  { label: "MeInteresa+NoMeInteresa+SinInteraccion=Vistos", parts: ["meInteresa", "noMeInteresa", "sinInteraccion"], total: "vistos" },
  { label: "Contactado+NoContactado=MeInteresa", parts: ["contactado", "noContactado"], total: "meInteresa" },
  { label: "Derivados+NoDerivados=Contactado", parts: ["derivados", "noDerivados"], total: "contactado" },
  { label: "Agencia+EnProcesoDerivados=Derivados", parts: ["agencia", "enProcesoDerivados"], total: "derivados" },
  { label: "Desembolso+EnProcesoAgencia+Rechazado=Agencia", parts: ["desembolso", "enProcesoAgencia", "rechazado"], total: "agencia" },
];

function checkSum(label: string, parts: Array<[string, number | null]>, total: number | null): string | null {
  if (total == null || parts.some(([, v]) => v == null)) {
    const faltantes = [...(total == null ? ["total"] : []), ...parts.filter(([, v]) => v == null).map(([n]) => n)];
    return `${label}: faltan campos (${faltantes.join(", ")})`;
  }
  const sum = parts.reduce((acc, [, v]) => acc + (v ?? 0), 0);
  if (sum !== total) return `${label}: ${parts.map(([n, v]) => `${n}(${v})`).join("+")} = ${sum} ≠ total ${total}`;
  return null;
}

export function reconcileLendingFunnel(f: LendingFunnelFields): LendingReconcileResult {
  const errors = FUNNEL_EQUATIONS.map((eq) => checkSum(eq.label, eq.parts.map((k) => [k, f[k]]), f[eq.total])).filter(
    (e): e is string => e !== null,
  );
  return { ok: errors.length === 0, errors };
}

export interface DerivedFieldInfo {
  campo: FieldKey;
  valor: number;
  ecuacion: string;
}

/**
 * Si falta EXACTAMENTE UN campo del funnel (los otros 14 sí se leyeron del PDF) y ese campo
 * aparece en alguna de las 6 ecuaciones con todos los demás términos ya conocidos, lo deduce por
 * aritmética simple — nunca si falta más de uno, nunca si el resultado da negativo (sin sentido
 * de negocio, mejor fallar explícito que inventar). El caller SIEMPRE debe re-verificar con
 * reconcileLendingFunnel() antes de aceptar el valor derivado.
 *
 * Motivo real (encontrado 2026-07-27): Power BI a veces abrevia un único valor puntual como "1K"
 * en vez del número completo ("NO CONTACTADO" ese día, en vez de "1.179") — probablemente por
 * ancho de la tarjeta — mientras el resto del funnel se lee normal. El resto de los 14 campos
 * alcanza para reconstruir el que falta sin ambigüedad.
 */
export function deriveMissingField(fields: LendingFunnelFields): DerivedFieldInfo | null {
  const missing = (Object.keys(fields) as FieldKey[]).filter((k) => fields[k] == null);
  if (missing.length !== 1) return null;
  const campo = missing[0];

  for (const eq of FUNNEL_EQUATIONS) {
    if (eq.total === campo) {
      const parts = eq.parts.map((k) => fields[k]);
      if (parts.some((v) => v == null)) continue;
      const valor = parts.reduce<number>((acc, v) => acc + (v ?? 0), 0);
      return { campo, valor, ecuacion: eq.label };
    }
    if (eq.parts.includes(campo)) {
      const total = fields[eq.total];
      if (total == null) continue;
      const otherParts = eq.parts.filter((k) => k !== campo).map((k) => fields[k]);
      if (otherParts.some((v) => v == null)) continue;
      const valor = total - otherParts.reduce<number>((acc, v) => acc + (v ?? 0), 0);
      if (valor < 0) continue;
      return { campo, valor, ecuacion: eq.label };
    }
  }
  return null;
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
    // Un único campo ilegible (ver deriveMissingField) es recuperable por aritmética — cualquier
    // otra combinación (2+ campos, o "EN PROCESO sin ancla"/conteo raro) sigue rechazando el
    // reporte entero como antes.
    const derived = issues.length === 1 ? deriveMissingField(fields) : null;
    if (derived) {
      const repaired = { ...fields, [derived.campo]: derived.valor };
      if (reconcileLendingFunnel(repaired).ok) {
        console.log(
          JSON.stringify({
            ts: Date.now(),
            msg: "kpi_ingest_lending_field_derived",
            campo: derived.campo,
            valor: derived.valor,
            ecuacion: derived.ecuacion,
            motivoOriginal: issues[0],
          }),
        );
        return { ok: true, fields: repaired };
      }
    }
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
