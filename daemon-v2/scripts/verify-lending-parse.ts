import { config as loadEnv } from "dotenv";
loadEnv({ path: `${process.env.HOME}/.cos-agent/.env` });
loadEnv({ path: `${process.env.HOME}/.claude/secrets/apps.env` });

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseAndValidateLendingReport } from "../src/proactive/kpi-ingest-lending-pdf.js";
import { upsertLendingRow, clearLendingFailNote, fillLendingDerivedFields } from "../src/proactive/kpi-lending-notion.js";

const require = createRequire(import.meta.url);
const { PDFParse } = require("pdf-parse") as {
  PDFParse: new (opts: { data: Uint8Array }) => { getText(): Promise<{ text: string }> };
};

/**
 * Verificación manual del parser de "Funnel Yape Lending" contra PDFs reales antes de confiar en
 * el cron automático — y, con `--write`, backfill de esas fechas a la DB "KPIs Yape Lending".
 *
 * Uso: tsx scripts/verify-lending-parse.ts 2026-07-21=/ruta/LENDING_21.pdf 2026-07-22=/ruta/... [--write]
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const pairs = args.filter((a) => a !== "--write");

  if (pairs.length === 0) {
    console.error("Uso: tsx scripts/verify-lending-parse.ts FECHA=RUTA.pdf [FECHA=RUTA.pdf ...] [--write]");
    process.exit(1);
  }

  const notionToken = process.env.NOTION_TOKEN;
  if (write && !notionToken) {
    console.error("Falta NOTION_TOKEN en el entorno (~/.cos-agent/.env o ~/.claude/secrets/apps.env) para --write.");
    process.exit(1);
  }

  const fechasEscritas: string[] = [];

  for (const pair of pairs) {
    const [fecha, path] = pair.split("=");
    if (!fecha || !path) {
      console.error(`Argumento inválido "${pair}" — formato FECHA=RUTA.pdf`);
      process.exit(1);
    }

    const buf = readFileSync(path);
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const { text } = await parser.getText();
    const result = parseAndValidateLendingReport(text);

    console.log(`\n=== ${fecha} (${path}) ===`);
    if (!result.ok) {
      console.log("❌ NO reconcilia:");
      for (const err of result.errors) console.log(`  - ${err}`);
      continue;
    }

    console.log("✅ Reconcilia. Campos:");
    for (const [k, v] of Object.entries(result.fields)) console.log(`  ${k}: ${v}`);

    if (write) {
      const raw = {
        Leads: result.fields.leads,
        "Ofertas Vistas": result.fields.vistos,
        "Ofertas No Vistas": result.fields.noVistos,
        "Me Interesa": result.fields.meInteresa,
        "No Me Interesa": result.fields.noMeInteresa,
        "Sin Interacción": result.fields.sinInteraccion,
        Contactado: result.fields.contactado,
        "No Contactado": result.fields.noContactado,
        Derivados: result.fields.derivados,
        "No Derivados": result.fields.noDerivados,
        "En Proceso (Derivados)": result.fields.enProcesoDerivados,
        Agencia: result.fields.agencia,
        Desembolso: result.fields.desembolso,
        "En Proceso (Agencia)": result.fields.enProcesoAgencia,
        Rechazado: result.fields.rechazado,
      };
      const up = await upsertLendingRow(notionToken!, fecha, raw);
      await clearLendingFailNote(notionToken!, fecha);
      console.log(`  → Notion: ${up.created ? "creado" : "actualizado"} (${up.fieldsWritten.join(", ")})`);
      fechasEscritas.push(fecha);
    }
  }

  if (write && fechasEscritas.length) {
    const derived = await fillLendingDerivedFields(notionToken!, fechasEscritas);
    console.log("\nDerivados:", JSON.stringify(derived, null, 2));
  }
}

main();
