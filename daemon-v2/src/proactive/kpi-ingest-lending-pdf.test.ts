import { describe, it, expect } from "vitest";
import {
  extractLendingFunnel,
  reconcileLendingFunnel,
  deriveMissingField,
  parseReportDateFromBody,
  parseAndValidateLendingReport,
  type LendingFunnelFields,
} from "./kpi-ingest-lending-pdf.js";

// Texto real extraído con pdf-parse de los 4 correos "Reporte diario Créditos Yape Lending -
// Riesgos" que Cal reenvió (cierres 2026-07-21/22/23/26 — verificado a mano contra el dashboard).
// 07-21 trae "SIN INTERACCION" sin tilde (typo real del reporte); 07-22/23/26 pegan el % anterior
// justo antes de "NO DERIVADOS" sin salto de línea ("27,1 %NO DERIVADOS") — ambos casos reales,
// no simulados.
const REAL_TEXT_2026_07_21 =
  "Power BI Desktop\nLEADS ENVIADOS\n0 \t20.666\n12K\nNOTIFICACIONES\n0,00K \t12,22K\n8.504\nCLICK POP UP\n0 \t8.504\n1467\nCONTACTADOS\n0 \t1467\n878\nFUNNEL PILOTO YAPE LENDING\nDERIVADOS AGENCIA\n0 \t878\n318\nDESEMBOLSOS\n0 \t97\n68\nLEADS\n12.220\n100 %\nVISTOS\n8.504\n69,6 %\nNO VISTOS\n3.716\n30,4 %\nME INTERESA\n1.467\nNO ME INTERESA\n2.428\n17,3 %\n28,6 %\nCONTACTADO\n878\nNO CONTACTADO\n589\n59,9 %\n40,1 %\nMONTO APROBADO\nAll \t\nCIUDAD\nAll \t\nDESEMBOLSO\n68\nEN PROCESO\n23\n70,1 %\n23,7 %\nNO DERIVADOS\n560\nDERIVADOS\n318\n63,8 %\n36,2 %\nEN PROCESO\n221\n69,5 %\nAGENCIA\n97\n30,5 %\nRECHAZADO\n6\n6,2 %\nSIN INTERACCION\n4.609\n54,2 %\n\n-- 1 of 1 --\n\n";

const REAL_TEXT_2026_07_22 =
  "Power BI Desktop\nLEADS ENVIADOS\n0 \t20.666\n12.220\nNOTIFICACIONES\n0,00K \t12,22K\n9.522\nCLICK POP UP\n0 \t9.522\n1522\nCONTACTADOS\n0 \t1522\n947\nFUNNEL PILOTO YAPE LENDING\nDERIVADOS AGENCIA\n0 \t947\n348\nDESEMBOLSOS\n0 \t107\n72\nLEADS\n12.220\n100 %\nVISTOS\n9.522\n77,9 %\nNO VISTOS\n2.698\n22,1 %\nME INTERESA\n1.522\nNO ME INTERESA\n2.772\n16,0 %\n29,1 %\nCONTACTADO\n947\nNO CONTACTADO\n575\n62,2 %\n37,8 %\nMONTO APROBADO\nAll \t\nCIUDAD\nAll \t\nDESEMBOLSO\n72\nEN PROCESO\n29\n67,3 %\n27,1 %NO DERIVADOS\n599\nDERIVADOS\n348\n63,3 %\n36,7 %\nEN PROCESO\n241\n69,3 %\nAGENCIA\n107\n30,7 %\nRECHAZADO\n6\n5,6 %\nSIN INTERACCIÓN\n5.228\n54,9 %\n\n-- 1 of 1 --\n\n";

const REAL_TEXT_2026_07_23 =
  "Power BI Desktop\nLEADS ENVIADOS\n0 \t29.090\n13.220\nNOTIFICACIONES\n0,00K \t13,22K\n9.522\nCLICK POP UP\n0 \t9.522\n1637\nCONTACTADOS\n0 \t1637\n991\nFUNNEL PILOTO YAPE LENDING\nDERIVADOS AGENCIA\n0 \t991\n384\nDESEMBOLSOS\n0 \t118\n78\nLEADS\n13.220\n100 %\nVISTOS\n9.522\n72,0 %\nNO VISTOS\n3.698\n28,0 %\nME INTERESA\n1.637\nNO ME INTERESA\n2.772\n17,2 %\n29,1 %\nCONTACTADO\n991\nNO CONTACTADO\n646\n60,5 %\n39,5 %\nMONTO APROBADO\nAll \t\nCIUDAD\nAll \t\nDESEMBOLSO\n78\nEN PROCESO\n34\n66,1 %\n28,8 %NO DERIVADOS\n607\nDERIVADOS\n384\n61,3 %\n38,7 %\nEN PROCESO\n266\n69,3 %\nAGENCIA\n118\n30,7 %\nRECHAZADO\n6\n5,1 %\nSIN INTERACCIÓN\n5.113\n53,7 %\n\n-- 1 of 1 --\n\n";

const REAL_TEXT_2026_07_26 =
  "Power BI Desktop\nLEADS ENVIADOS\n0 \t29.090\n15.720\nNOTIFICACIONES\n0,00K \t15,72K\n12K\nCLICK POP UP\n0,00K \t12,13K\n2066\nCONTACTADOS\n0 \t2066\n1098\nFUNNEL PILOTO YAPE LENDING\nDERIVADOS AGENCIA\n0 \t1098\n435\nDESEMBOLSOS\n0 \t140\n85\nLEADS\n15.720\n100 %\nVISTOS\n12.129\n77,2 %\nNO VISTOS\n3.591\n22,8 %\nME INTERESA\n2.066\nNO ME INTERESA\n3.717\n17,0 %\n30,6 %\nCONTACTADO\n1.098\nNO CONTACTADO\n968\n53,1 %\n46,9 %\nMONTO APROBADO\nAll \t\nCIUDAD\nAll \t\nDESEMBOLSO\n85\nEN PROCESO\n44\n60,7 %\n31,4 %NO DERIVADOS\n663\nDERIVADOS\n435\n60,4 %\n39,6 %\nEN PROCESO\n295\n67,8 %\nAGENCIA\n140\n32,2 %\nRECHAZADO\n11\n7,9 %\nSIN INTERACCIÓN\n6.346\n52,3 %\n\n-- 1 of 1 --\n\n";

// 2026-07-27 real (mail id 19fa930663dfec44) — Power BI abrevió "NO CONTACTADO" como "1K" en vez
// del número completo ("1.179"), la única vez que se vio esto en un campo del schema. El resto
// de los 14 campos parsea normal — cubre deriveMissingField()/el fallback de reconciliación.
const REAL_TEXT_2026_07_27 =
  "Power BI Desktop\nLEADS ENVIADOS\n0 \t29.090\n17.220\nNOTIFICACIONES\n0,00K \t17,22K\n14K\nCLICK POP UP\n0,00K \t13,75K\n2358\nCONTACTADOS\n0 \t2358\n1179\nFUNNEL PILOTO YAPE LENDING\nDERIVADOS AGENCIA\n0 \t1179\n459\nDESEMBOLSOS\n0 \t166\n86\nLEADS\n17.220\n100 %\nVISTOS\n13.746\n79,8 %\nNO VISTOS\n3.474\n20,2 %\nME INTERESA\n2.358\nNO ME INTERESA\n4.606\n17,2 %\n33,5 %\nCONTACTADO\n1.179\nNO CONTACTADO\n1K\n50,0 %\n50,0 %\nMONTO APROBADO\nAll \t\nCIUDAD\nAll \t\nDESEMBOLSO\n86\nEN PROCESO\n69\n51,8 %\n41,6 %NO DERIVADOS\n720\nDERIVADOS\n459\n61,1 %\n38,9 %\nEN PROCESO\n293\n63,8 %\nAGENCIA\n166\n36,2 %\nRECHAZADO\n11\n6,6 %\nSIN INTERACCIÓN\n6.782\n49,3 %\n\n-- 1 of 1 --\n\n";

describe("extractLendingFunnel", () => {
  it("parsea los 15 nodos del 2026-07-21 (label 'SIN INTERACCION' sin tilde)", () => {
    const { fields, issues } = extractLendingFunnel(REAL_TEXT_2026_07_21);
    expect(issues).toEqual([]);
    expect(fields).toEqual<LendingFunnelFields>({
      leads: 12220,
      vistos: 8504,
      noVistos: 3716,
      meInteresa: 1467,
      noMeInteresa: 2428,
      sinInteraccion: 4609,
      contactado: 878,
      noContactado: 589,
      derivados: 318,
      noDerivados: 560,
      enProcesoDerivados: 221,
      agencia: 97,
      desembolso: 68,
      enProcesoAgencia: 23,
      rechazado: 6,
    });
  });

  it("parsea el 2026-07-22 pese a '27,1 %NO DERIVADOS' pegado en una sola línea", () => {
    const { fields, issues } = extractLendingFunnel(REAL_TEXT_2026_07_22);
    expect(issues).toEqual([]);
    expect(fields.noDerivados).toBe(599);
    expect(fields.enProcesoAgencia).toBe(29);
    expect(fields.enProcesoDerivados).toBe(241);
  });

  it("parsea el 2026-07-23 completo", () => {
    const { fields, issues } = extractLendingFunnel(REAL_TEXT_2026_07_23);
    expect(issues).toEqual([]);
    expect(fields).toEqual<LendingFunnelFields>({
      leads: 13220,
      vistos: 9522,
      noVistos: 3698,
      meInteresa: 1637,
      noMeInteresa: 2772,
      sinInteraccion: 5113,
      contactado: 991,
      noContactado: 646,
      derivados: 384,
      noDerivados: 607,
      enProcesoDerivados: 266,
      agencia: 118,
      desembolso: 78,
      enProcesoAgencia: 34,
      rechazado: 6,
    });
  });

  it("parsea el 2026-07-26 completo y resuelve bien la ambigüedad 'EN PROCESO' x2", () => {
    const { fields, issues } = extractLendingFunnel(REAL_TEXT_2026_07_26);
    expect(issues).toEqual([]);
    expect(fields).toEqual<LendingFunnelFields>({
      leads: 15720,
      vistos: 12129,
      noVistos: 3591,
      meInteresa: 2066,
      noMeInteresa: 3717,
      sinInteraccion: 6346,
      contactado: 1098,
      noContactado: 968,
      derivados: 435,
      noDerivados: 663,
      enProcesoDerivados: 295,
      agencia: 140,
      desembolso: 85,
      enProcesoAgencia: 44,
      rechazado: 11,
    });
  });

  it("reporta un issue si 'EN PROCESO' no tiene ancla reconocible", () => {
    const text = "LEADS\n100\nEN PROCESO\n5\n";
    const { issues } = extractLendingFunnel(text);
    // "leads" no tiene entrada en EN_PROCESO_BRANCH_BY_ANCHOR → sin ancla resoluble
    expect(issues.some((i) => i.motivo.includes("sin ancla reconocible"))).toBe(true);
  });

  it("una sola 'EN PROCESO' deja la otra rama en null, sin issue propio (lo atrapa el chequeo de campos faltantes más arriba)", () => {
    const text = "DESEMBOLSO\n10\nEN PROCESO\n2\n";
    const { fields, issues } = extractLendingFunnel(text);
    expect(fields.enProcesoAgencia).toBe(2);
    expect(fields.enProcesoDerivados).toBeNull();
    expect(issues).toEqual([]);
  });

  it("reconoce 'TOTAL' como alias de 'LEADS' (rename de Power BI, 2026-08-19/20)", () => {
    const text = "TOTAL\n29090\nVISTOS\n25527\n";
    const { fields } = extractLendingFunnel(text);
    expect(fields.leads).toBe(29090);
  });

  it("reconoce 'SIN VISITA' como alias directo de la rama Derivados→Agencia (rename de Power BI, 2026-08-19/20)", () => {
    const text = "DERIVADOS\n705\nAGENCIA\n334\nSIN VISITA\n371\n";
    const { fields, issues } = extractLendingFunnel(text);
    expect(fields.enProcesoDerivados).toBe(371);
    expect(issues).toEqual([]);
  });

  it("formato nuevo completo (TOTAL + SIN VISITA + un solo EN PROCESO) reconcilia sin issues — reproduce el PDF real del 2026-08-19", () => {
    // Mismos números que el reporte real del 19/8 que rompía con el parser viejo.
    const text =
      "TOTAL\n29090\nVISTOS\n25527\nNO VISTOS\n3563\nME INTERESA\n2200\nNO ME INTERESA\n4000\n" +
      "SIN INTERACCION\n19327\nCONTACTADO\n1200\nNO CONTACTADO\n1000\nDERIVADOS\n705\n" +
      "NO DERIVADOS\n495\nAGENCIA\n334\nSIN VISITA\n371\nDESEMBOLSO\n200\nEN PROCESO\n100\nRECHAZADO\n34\n";
    const { fields, issues } = extractLendingFunnel(text);
    expect(issues).toEqual([]);
    expect(fields.leads).toBe(29090);
    expect(fields.enProcesoDerivados).toBe(371);
    expect(fields.enProcesoAgencia).toBe(100);
    expect(reconcileLendingFunnel(fields).ok).toBe(true);
  });

  it("nunca confunde 'NO VISTOS' con la label 'VISTOS' (residuo con letras se rechaza)", () => {
    const text = "NO VISTOS\n999\nVISTOS\n111\n";
    const { fields } = extractLendingFunnel(text);
    expect(fields.noVistos).toBe(999);
    expect(fields.vistos).toBe(111);
  });

  it("el 2026-07-27 reporta un issue en noContactado ('1K' no es un número parseable) — extractLendingFunnel por sí solo no lo deduce", () => {
    const { fields, issues } = extractLendingFunnel(REAL_TEXT_2026_07_27);
    expect(fields.noContactado).toBeNull();
    expect(issues).toEqual([{ campo: "noContactado", motivo: "no pude leer el valor tras la label en línea 37" }]);
  });
});

describe("deriveMissingField", () => {
  const base: LendingFunnelFields = {
    leads: 15720,
    vistos: 12129,
    noVistos: 3591,
    meInteresa: 2066,
    noMeInteresa: 3717,
    sinInteraccion: 6346,
    contactado: 1098,
    noContactado: 968,
    derivados: 435,
    noDerivados: 663,
    enProcesoDerivados: 295,
    agencia: 140,
    desembolso: 85,
    enProcesoAgencia: 44,
    rechazado: 11,
  };

  it("deduce un campo que es 'parte' de una ecuación (noContactado desde Contactado+NoContactado=MeInteresa)", () => {
    const { fields } = extractLendingFunnel(REAL_TEXT_2026_07_27);
    const derived = deriveMissingField(fields);
    expect(derived).toEqual({ campo: "noContactado", valor: 1179, ecuacion: "Contactado+NoContactado=MeInteresa" });
  });

  it("deduce un campo que es el 'total' de una ecuación (leads desde Vistos+NoVistos)", () => {
    const derived = deriveMissingField({ ...base, leads: null });
    expect(derived).toEqual({ campo: "leads", valor: 15720, ecuacion: "Vistos+NoVistos=Leads" });
  });

  it("devuelve null si faltan 2 o más campos (no es 'exactamente uno')", () => {
    expect(deriveMissingField({ ...base, leads: null, agencia: null })).toBeNull();
  });

  it("devuelve null si no falta ningún campo", () => {
    expect(deriveMissingField(base)).toBeNull();
  });

  it("devuelve null en vez de un valor negativo (sin sentido de negocio)", () => {
    // noVistos = leads(10) - vistos(15) = -5 → se rechaza en vez de "inventar" un negativo.
    const adversarial = { ...base, leads: 10, vistos: 15, noVistos: null };
    expect(deriveMissingField(adversarial)).toBeNull();
  });
});

describe("reconcileLendingFunnel", () => {
  const base: LendingFunnelFields = {
    leads: 15720,
    vistos: 12129,
    noVistos: 3591,
    meInteresa: 2066,
    noMeInteresa: 3717,
    sinInteraccion: 6346,
    contactado: 1098,
    noContactado: 968,
    derivados: 435,
    noDerivados: 663,
    enProcesoDerivados: 295,
    agencia: 140,
    desembolso: 85,
    enProcesoAgencia: 44,
    rechazado: 11,
  };

  it("pasa con los 4 días reales", () => {
    for (const text of [REAL_TEXT_2026_07_21, REAL_TEXT_2026_07_22, REAL_TEXT_2026_07_23, REAL_TEXT_2026_07_26]) {
      const { fields } = extractLendingFunnel(text);
      expect(reconcileLendingFunnel(fields as LendingFunnelFields).ok).toBe(true);
    }
  });

  it("detecta corrupción en cada uno de los 15 campos", () => {
    for (const key of Object.keys(base) as Array<keyof LendingFunnelFields>) {
      const corrupted = { ...base, [key]: (base[key] ?? 0) + 1 };
      const result = reconcileLendingFunnel(corrupted);
      expect(result.ok).toBe(false);
    }
  });
});

describe("parseReportDateFromBody", () => {
  it("extrae la fecha ISO de 'cierre de la jornada de 2026-07-26'", () => {
    const body = "información actualizada al cierre de la jornada de 2026-07-26 .";
    expect(parseReportDateFromBody(body)).toBe("2026-07-26");
  });

  it("devuelve null si el patrón no está", () => {
    expect(parseReportDateFromBody("un cuerpo de mail sin esa frase")).toBeNull();
  });
});

describe("parseAndValidateLendingReport", () => {
  it("ok:true para los 4 reportes reales", () => {
    for (const text of [REAL_TEXT_2026_07_21, REAL_TEXT_2026_07_22, REAL_TEXT_2026_07_23, REAL_TEXT_2026_07_26]) {
      const result = parseAndValidateLendingReport(text);
      expect(result.ok).toBe(true);
    }
  });

  it("ok:false con errores explícitos si el texto no reconcilia", () => {
    const broken = REAL_TEXT_2026_07_26.replace("VISTOS\n12.129", "VISTOS\n99999");
    const result = parseAndValidateLendingReport(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });

  it("ok:true para el 2026-07-27 pese a 'NO CONTACTADO' abreviado como '1K' — lo deduce por reconciliación", () => {
    const result = parseAndValidateLendingReport(REAL_TEXT_2026_07_27);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fields.noContactado).toBe(1179);
      expect(reconcileLendingFunnel(result.fields).ok).toBe(true);
    }
  });

  it("ok:false si faltan 2+ campos, aunque uno sea matemáticamente deducible (nunca deriva de a más de uno)", () => {
    const broken = REAL_TEXT_2026_07_27.replace("AGENCIA\n166", "AGENCIA\nXYZ");
    const result = parseAndValidateLendingReport(broken);
    expect(result.ok).toBe(false);
  });
});
