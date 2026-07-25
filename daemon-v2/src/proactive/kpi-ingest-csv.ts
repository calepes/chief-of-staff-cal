export function detectDelimiter(headerLine: string): "," | ";" {
  const countOutsideQuotes = (line: string, ch: string): number => {
    let count = 0;
    let inQuotes = false;
    for (const c of line) {
      if (c === '"') inQuotes = !inQuotes;
      else if (c === ch && !inQuotes) count++;
    }
    return count;
  };
  const commas = countOutsideQuotes(headerLine, ",");
  const semicolons = countOutsideQuotes(headerLine, ";");
  return semicolons > commas ? ";" : ",";
}

export function parseNumber(raw: string): number | null {
  const v = raw.trim();
  if (v === "") return null;
  // Miles-sin-decimales (grupos de exactamente 3 dígitos, un solo tipo de separador) se
  // evalúan ANTES que los patrones "decimal sin separador de miles": con un solo tipo de
  // separador y exactamente 3 dígitos tras él ("12.345"/"12,345"), el caso es ambiguo entre
  // "miles sin decimales" y "decimal de 3 cifras" — por convención (y por los tests) gana miles.
  if (/^-?\d{1,3}(\.\d{3})+$/.test(v)) {
    return Number(v.replace(/\./g, ""));
  }
  if (/^-?\d{1,3}(,\d{3})+$/.test(v)) {
    return Number(v.replace(/,/g, ""));
  }
  if (/^-?\d{1,3}(\.\d{3})*,\d+$/.test(v)) {
    return Number(v.replace(/\./g, "").replace(",", "."));
  }
  if (/^-?\d{1,3}(,\d{3})*\.\d+$/.test(v)) {
    return Number(v.replace(/,/g, ""));
  }
  // Catch-all decimal con coma sin separador de miles (parte entera de cualquier largo,
  // ej. "12345,67"), análogo al catch-all de punto de abajo — sin esto, un decimal LatAm
  // con parte entera de 4+ dígitos y sin agrupar en miles quedaba sin matchear ningún patrón.
  if (/^-?\d+,\d+$/.test(v)) {
    return Number(v.replace(",", "."));
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    return Number(v);
  }
  return null;
}

export function normalizeDate(raw: string): string | null {
  const v = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(v);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return null;
}

export function isSunday(fechaIso: string): boolean {
  return new Date(`${fechaIso}T00:00:00Z`).getUTCDay() === 0;
}

export interface ParsedCsvRow {
  fecha: string | null;
  raw: Record<string, number | null>;
  unmapped: string[];
  illegible: string[];
}

export interface ParseCsvResult {
  rows: ParsedCsvRow[];
  headerMapped: number;
}

const COLUMN_ALIASES: Record<string, string> = {
  "fecha": "Fecha",
  "date": "Fecha",
  "afiliaciones diarias": "Afiliaciones diarias",
  "afiliaciones nuevas": "Afiliaciones diarias",
  "trx": "TRX",
  "transacciones": "TRX",
  "activos dau": "Activos DAU",
  "dau": "Activos DAU",
  "activos 30d": "Activos 30d",
  "mau": "Activos 30d",
  "stock afiliados": "Stock Afiliados",
  "saldo": "Saldo",
  "remesas (cantidad)": "Remesas (cantidad)",
  "remesas cantidad": "Remesas (cantidad)",
  "remesas (usd)": "Remesas (USD)",
  "remesas usd": "Remesas (USD)",
  "activos 30d %": "Activos 30d %",
  "dau 7d": "DAU Promedio 7d",
  "activos dau %": "Activos DAU %",
  "ingresos recaudacion": "Ingresos Recaudacion",
  "ingresos recargas": "Ingresos Recargas",
  "ingresos pds": "Ingresos PDS",
};

const PERCENT_PROPS = new Set(["Activos 30d %", "Activos DAU %"]);

const DIACRITICS_RANGE_START = 0x0300;
const DIACRITICS_RANGE_END = 0x036f;

function normalizeHeaderName(h: string): string {
  const stripped = Array.from(h.normalize("NFD"))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < DIACRITICS_RANGE_START || code > DIACRITICS_RANGE_END;
    })
    .join("");
  return stripped.trim().toLowerCase();
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (const c of line) {
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === delimiter && !inQuotes) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseCsv(content: string): ParseCsvResult {
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { rows: [], headerMapped: 0 };

  const delimiter = detectDelimiter(lines[0]);
  const headerCols = splitCsvLine(lines[0], delimiter);
  const mapped = headerCols.map((h) => COLUMN_ALIASES[normalizeHeaderName(h)] ?? null);
  const headerMapped = mapped.filter(Boolean).length;

  const rows: ParsedCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i], delimiter);
    const raw: Record<string, number | null> = {};
    const unmapped: string[] = [];
    const illegible: string[] = [];
    let fecha: string | null = null;

    for (let c = 0; c < headerCols.length; c++) {
      const prop = mapped[c];
      const cellRaw = cols[c] ?? "";
      if (!prop) {
        if (cellRaw.trim() !== "") unmapped.push(headerCols[c]);
        continue;
      }
      if (prop === "Fecha") {
        fecha = normalizeDate(cellRaw);
        if (!fecha && cellRaw.trim() !== "") illegible.push("Fecha");
        continue;
      }
      if (cellRaw.trim() === "") continue;
      let cellForParsing = cellRaw.trim();
      let isPercent = false;
      if (PERCENT_PROPS.has(prop) && cellForParsing.endsWith("%")) {
        cellForParsing = cellForParsing.slice(0, -1).trim();
        isPercent = true;
      }
      const num = parseNumber(cellForParsing);
      if (num === null) illegible.push(prop);
      else raw[prop] = isPercent ? num / 100 : num;
    }

    rows.push({ fecha, raw, unmapped: [...new Set(unmapped)], illegible: [...new Set(illegible)] });
  }

  return { rows, headerMapped };
}

export function applySundayRule(fecha: string, raw: Record<string, number | null>): Record<string, number | null> {
  if (isSunday(fecha) && raw["Afiliaciones diarias"] === 0) {
    return { ...raw, "Afiliaciones diarias": null };
  }
  return raw;
}
