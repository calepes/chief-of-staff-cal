import { describe, it, expect } from "vitest";
import { extractPdfKpis, isFailedReport, parseReportDateFromFilename } from "./kpi-ingest-pdf.js";

// Fragmento real (texto extraído con pdf-parse de un PDF "Seguimiento Diario Yape Bolivia" real,
// 2026-07-23) — incluye el typo real de Yape ("vs. Sem. anteior", sin r) en el bloque Afiliados 7d.
const REAL_TEXT = `
YAPE BOLIVIA | Seguimiento Diario
Afiliaciones diarias 	Afiliaciones (Prom. 7d)
Afiliaciones diarias
4,977
vs. Día anterior : ▲ +0.4%
vs. Sem. anterior : ▲ +7.1%
Afiliados 7d
4,844
vs. Día anterior : ▲ +1.1%
vs. Sem. anteior : ▼ -4.0%
TRX
3,759,966
vs. Día anterior : ▲ +0.8%
vs. Sem. anterior : ▼ -10.3%
TRX Promedio 7d
3,909,550
vs. Día anterior : ▼ -1.6%
vs. Sem. anterior : ▼ -4.5%
950,000
1,000,000
Activos DAU 	DAU (Prom. 7d)
Activos DAU
1,150,676
vs. Día anterior : ▲ +0.1%
vs. Sem. anterior : ▼ -3.3%
DAU Promedio 7d
1,152,720
vs. Día anterior : ▼ -0.5%
vs. Sem. anterior : ▼ -1.2%
`;

describe("extractPdfKpis", () => {
  it("extrae los 5 valores y sus % vs. Ayer/Sem. del texto real", () => {
    const r = extractPdfKpis(REAL_TEXT);
    expect(r.afiliacionesDiarias).toBe(4977);
    expect(r.afiliados7d).toBe(4844);
    expect(r.trx).toBe(3759966);
    expect(r.trxPromedio7d).toBe(3909550);
    expect(r.activosDau).toBe(1150676);
    expect(r.afiliacionesVsAyer).toBeCloseTo(0.004, 5);
    expect(r.afiliacionesVsSemana).toBeCloseTo(0.071, 5);
    expect(r.trxVsAyer).toBeCloseTo(0.008, 5);
    expect(r.trxVsSemana).toBeCloseTo(-0.103, 5);
    expect(r.dauVsAyer).toBeCloseTo(0.001, 5);
    expect(r.dauVsSemana).toBeCloseTo(-0.033, 5);
  });

  it("no confunde la etiqueta de gráfico ('Afiliaciones diarias\\tAfiliaciones (Prom. 7d)') con el bloque real", () => {
    const r = extractPdfKpis(REAL_TEXT);
    // si hubiera matcheado la línea del gráfico como bloque, el valor siguiente sería texto no numérico
    expect(r.afiliacionesDiarias).toBe(4977);
  });

  it("ignora el bloque de Afiliados 7d para los % (esa propiedad no existe en la DB)", () => {
    const r = extractPdfKpis(REAL_TEXT);
    expect(r).not.toHaveProperty("afiliados7dVsAyer");
  });

  it("devuelve todo null si el texto no tiene ninguna etiqueta reconocida", () => {
    const r = extractPdfKpis("texto sin relación\notra línea\n");
    expect(r.afiliacionesDiarias).toBeNull();
    expect(r.trx).toBeNull();
    expect(r.activosDau).toBeNull();
  });

  it("no rompe si un bloque no tiene línea de valor después (fin de texto)", () => {
    const r = extractPdfKpis("TRX");
    expect(r.trx).toBeNull();
  });

  it("toma el primer match si una etiqueta aparece más de una vez (no pisa con el segundo)", () => {
    const text = "TRX\n100\nvs. Día anterior : ▲ +1.0%\nvs. Sem. anterior : ▲ +2.0%\nTRX\n999\n";
    const r = extractPdfKpis(text);
    expect(r.trx).toBe(100);
  });
});

describe("isFailedReport", () => {
  it("detecta 'updated fail' case-insensitive", () => {
    expect(isFailedReport("algo algo Updated Fail! algo")).toBe(true);
    expect(isFailedReport("updated fail")).toBe(true);
  });

  it("no detecta falso positivo en un reporte normal", () => {
    expect(isFailedReport(REAL_TEXT)).toBe(false);
  });

  it("detecta 'UPDATE\\nFAILED' (sin 'd' en UPDATE, en líneas separadas) — caso real 2026-07-24", () => {
    // Fragmento real del PDF de 24/07/2026: BCP marcó el widget de Afiliaciones como
    // fallido con este texto exacto, sin la 'd' de "updated" y partido en dos líneas.
    const text = "AFILIACIONES DIARIA\tACTIVOS DIARIOS\tTRANSACCIONES DIARIAS\nUPDATE\nFAILED\n";
    expect(isFailedReport(text)).toBe(true);
  });
});

describe("parseReportDateFromFilename", () => {
  it("extrae la fecha del filename real y la normaliza a ISO", () => {
    expect(parseReportDateFromFilename("Seguimiento Diario Yape | 22/07/2026.PDF")).toBe("2026-07-22");
  });

  it("devuelve null si el filename no tiene una fecha DD/MM/YYYY", () => {
    expect(parseReportDateFromFilename("reporte-sin-fecha.pdf")).toBeNull();
  });
});
