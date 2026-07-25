import { describe, it, expect } from "vitest";
import { detectDelimiter, parseNumber, normalizeDate, isSunday } from "./kpi-ingest-csv.js";
import { parseCsv, applySundayRule } from "./kpi-ingest-csv.js";

describe("detectDelimiter", () => {
  it("detecta coma cuando hay más comas que punto y comas", () => {
    expect(detectDelimiter("Fecha,TRX,Activos DAU")).toBe(",");
  });
  it("detecta punto y coma cuando hay más ; que ,", () => {
    expect(detectDelimiter("Fecha;TRX;Activos DAU")).toBe(";");
  });
  it("ignora delimitadores dentro de comillas", () => {
    expect(detectDelimiter('"Nota, con coma",TRX,DAU')).toBe(",");
  });
});

describe("parseNumber", () => {
  it("parsea estilo LatAm (punto=miles, coma=decimal)", () => {
    expect(parseNumber("1.234,56")).toBeCloseTo(1234.56);
  });
  it("parsea estilo US (coma=miles, punto=decimal)", () => {
    expect(parseNumber("1,234.56")).toBeCloseTo(1234.56);
  });
  it("parsea miles sin decimales (con punto)", () => {
    expect(parseNumber("12.345")).toBe(12345);
  });
  it("parsea miles sin decimales (con coma)", () => {
    expect(parseNumber("12,345")).toBe(12345);
  });
  it("parsea un número plano", () => {
    expect(parseNumber("42")).toBe(42);
  });
  it("parsea un decimal plano con punto", () => {
    expect(parseNumber("42.5")).toBe(42.5);
  });
  it("devuelve null para vacío", () => {
    expect(parseNumber("")).toBeNull();
  });
  it("devuelve null para texto ilegible", () => {
    expect(parseNumber("N/D")).toBeNull();
  });
  it("parsea decimal LatAm sin separador de miles (parte entera de 5 dígitos)", () => {
    expect(parseNumber("12345,67")).toBeCloseTo(12345.67);
  });
  it("parsea decimal LatAm sin separador de miles (parte entera de 4 dígitos)", () => {
    expect(parseNumber("1234,5")).toBeCloseTo(1234.5);
  });
  it("parsea decimal LatAm negativo sin separador de miles", () => {
    expect(parseNumber("-1234,56")).toBeCloseTo(-1234.56);
  });
});

describe("normalizeDate", () => {
  it("deja pasar YYYY-MM-DD", () => {
    expect(normalizeDate("2026-07-20")).toBe("2026-07-20");
  });
  it("normaliza DD/MM/YYYY", () => {
    expect(normalizeDate("20/07/2026")).toBe("2026-07-20");
  });
  it("normaliza DD-MM-YYYY", () => {
    expect(normalizeDate("20-07-2026")).toBe("2026-07-20");
  });
  it("normaliza día/mes de un solo dígito", () => {
    expect(normalizeDate("5/7/2026")).toBe("2026-07-05");
  });
  it("devuelve null para formato desconocido", () => {
    expect(normalizeDate("julio 20")).toBeNull();
  });
});

describe("isSunday", () => {
  it("identifica un domingo", () => {
    expect(isSunday("2026-07-19")).toBe(true);
  });
  it("identifica un día que no es domingo", () => {
    expect(isSunday("2026-07-20")).toBe(false);
  });
});

describe("parseCsv", () => {
  it("mapea columnas conocidas y arma filas", () => {
    const csv = "Fecha,TRX,Activos DAU\n2026-07-20,12345,678\n2026-07-21,,700\n";
    const result = parseCsv(csv);
    expect(result.headerMapped).toBe(3);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({
      fecha: "2026-07-20",
      raw: { TRX: 12345, "Activos DAU": 678 },
      unmapped: [],
      illegible: [],
    });
    expect(result.rows[1].raw["TRX"]).toBeUndefined();
  });

  it("reconoce alias de columnas (Afiliaciones Nuevas, DAU, MAU)", () => {
    const csv = "Fecha,Afiliaciones Nuevas,DAU,MAU\n2026-07-20,50,678,9000\n";
    const result = parseCsv(csv);
    expect(result.rows[0].raw).toEqual({
      "Afiliaciones diarias": 50,
      "Activos DAU": 678,
      "Activos 30d": 9000,
    });
  });

  it("reconoce las columnas extra del export real de BCP (DAU 7d, Ingresos x3)", () => {
    const csv = "Fecha,DAU 7d,Ingresos Recaudacion,Ingresos Recargas,Ingresos PDS\n2026-07-20,1159565,256767,224809,31958\n";
    const result = parseCsv(csv);
    expect(result.rows[0].raw).toEqual({
      "DAU Promedio 7d": 1159565,
      "Ingresos Recaudacion": 256767,
      "Ingresos Recargas": 224809,
      "Ingresos PDS": 31958,
    });
  });

  it("parsea columnas de porcentaje (Activos 30d %, Activos DAU %) como fracción para el formato percent de Notion", () => {
    const csv = 'Fecha,Activos 30d %,Activos DAU %\n2026-07-20,"51,2 %","26,2 %"\n';
    const result = parseCsv(csv);
    expect(result.rows[0].raw["Activos 30d %"]).toBeCloseTo(0.512);
    expect(result.rows[0].raw["Activos DAU %"]).toBeCloseTo(0.262);
  });

  it("reconoce 'Date' (inglés, formato real del export de BCP) como alias de Fecha", () => {
    const csv = "Date,TRX\n01/07/2026,4231704\n";
    const result = parseCsv(csv);
    expect(result.rows[0].fecha).toBe("2026-07-01");
    expect(result.rows[0].raw).toEqual({ TRX: 4231704 });
  });

  it("reporta columnas no mapeadas y valores ilegibles", () => {
    const csv = "Fecha,ColumnaRara,TRX\n2026-07-20,algo,N/D\n";
    const result = parseCsv(csv);
    expect(result.rows[0].unmapped).toEqual(["ColumnaRara"]);
    expect(result.rows[0].illegible).toEqual(["TRX"]);
  });

  it("detecta delimitador ; y parsea igual", () => {
    const csv = "Fecha;TRX\n2026-07-20;1.500\n";
    const result = parseCsv(csv);
    expect(result.rows[0].raw["TRX"]).toBe(1500);
  });

  it("ignora líneas vacías", () => {
    const csv = "Fecha,TRX\n2026-07-20,100\n\n2026-07-21,200\n";
    const result = parseCsv(csv);
    expect(result.rows).toHaveLength(2);
  });

  it("no separa un campo entre comillas que contiene el delimitador", () => {
    const csv = 'Fecha,Notas,TRX\n2026-07-20,"a, b",100\n';
    const result = parseCsv(csv);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].raw["TRX"]).toBe(100);
    expect(result.rows[0].unmapped).toEqual(["Notas"]);
  });

  it("CSV con solo header (sin filas de datos)", () => {
    const result = parseCsv("Fecha,TRX\n");
    expect(result).toEqual({ rows: [], headerMapped: 2 });
  });

  it("CSV vacío", () => {
    const result = parseCsv("");
    expect(result).toEqual({ rows: [], headerMapped: 0 });
  });
});

describe("applySundayRule", () => {
  it("convierte Afiliaciones diarias=0 en null si la fecha es domingo", () => {
    const result = applySundayRule("2026-07-19", { "Afiliaciones diarias": 0, TRX: 100 });
    expect(result["Afiliaciones diarias"]).toBeNull();
    expect(result.TRX).toBe(100);
  });
  it("no toca el valor si no es domingo", () => {
    const result = applySundayRule("2026-07-20", { "Afiliaciones diarias": 0 });
    expect(result["Afiliaciones diarias"]).toBe(0);
  });
  it("no toca el valor si es domingo pero no es 0", () => {
    const result = applySundayRule("2026-07-19", { "Afiliaciones diarias": 5 });
    expect(result["Afiliaciones diarias"]).toBe(5);
  });
});
