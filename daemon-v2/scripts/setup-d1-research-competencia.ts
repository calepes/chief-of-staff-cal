import { config as loadEnv } from "dotenv";
loadEnv({ path: `${process.env.HOME}/.claude/secrets/apps.env` });

import { resolveD1Credentials } from "./research-competencia-cf-token.js";

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
// Token de CF resuelto desde 1Password (vault Daemons, ítem "Research Competencia D1") en vez de
// DIGEST_CF_API_TOKEN en texto plano — decisión de Cal 2026-09-09. Mismo valor que antes (reusa el
// token del Digest, copiado al ítem nuevo), solo cambia de dónde se lee.
const d1Credentials = resolveD1Credentials();
const TOKEN = d1Credentials?.token;
const DB_NAME = "research-competencia";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  fecha TEXT,
  caption TEXT,
  es_video INTEGER NOT NULL,
  media_urls TEXT,
  imagenes_desc TEXT,
  video_transcripcion TEXT,
  video_frames TEXT,
  run_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_entity_fecha ON posts(entity_id, fecha);
`.trim();

async function main(): Promise<void> {
  if (!ACCOUNT_ID) {
    console.error("❌ Falta CF_ACCOUNT_ID en el entorno (~/.claude/secrets/apps.env).");
    process.exit(1);
  }
  if (!TOKEN) {
    console.error("❌ No pude resolver el token de Cloudflare desde 1Password (vault Daemons, ítem \"Research Competencia D1\").");
    process.exit(1);
  }

  console.log(`Creando (o reusando) la D1 database "${DB_NAME}"...`);
  const createRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: DB_NAME }),
  });
  const createData = (await createRes.json()) as { success: boolean; result?: { uuid: string }; errors?: unknown[] };

  let databaseId: string;
  if (createData.success && createData.result) {
    databaseId = createData.result.uuid;
    console.log(`✅ Database creada: ${databaseId}`);
  } else {
    // Ya existe — listar para encontrar el uuid en vez de fallar.
    console.log("La database ya existe (o el create falló por otro motivo) — buscándola en la lista...");
    const listRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database?name=${DB_NAME}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const listData = (await listRes.json()) as { success: boolean; result?: Array<{ uuid: string; name: string }> };
    const found = listData.result?.find((d) => d.name === DB_NAME);
    if (!found) {
      console.error("❌ No encontré ni pude crear la database. Respuesta del create:", JSON.stringify(createData.errors));
      process.exit(1);
    }
    databaseId = found.uuid;
    console.log(`✅ Database ya existía: ${databaseId}`);
  }

  console.log("Aplicando el schema (CREATE TABLE posts)...");
  const schemaRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${databaseId}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql: SCHEMA_SQL }),
  });
  const schemaData = (await schemaRes.json()) as { success: boolean; errors?: unknown[] };
  if (!schemaData.success) {
    console.error("❌ Falló aplicar el schema:", JSON.stringify(schemaData.errors));
    process.exit(1);
  }

  if (databaseId !== d1Credentials?.databaseId) {
    console.log(`\n⚠️ El database_id devuelto (${databaseId}) no coincide con el guardado en 1Password (${d1Credentials?.databaseId}) — actualizá el campo "database_id" del ítem "Research Competencia D1" en el vault Daemons.`);
  } else {
    console.log(`\n✅ Listo. database_id: ${databaseId} (ya coincide con 1Password, vault Daemons).`);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
