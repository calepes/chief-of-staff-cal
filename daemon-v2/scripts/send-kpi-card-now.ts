import { config as loadEnv } from "dotenv";
loadEnv({ path: `${process.env.HOME}/.cos-agent/.env` });
loadEnv({ path: `${process.env.HOME}/.claude/secrets/apps.env` });

import { checkKpiCardDaily } from "../src/proactive/kpi-card-daily.js";

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Genera y manda la tarjeta de KPIs de Yape (TRX + Activos DAU) fuera del
 * horario del cron — mismo código que `scheduleKpiCardDaily()` en index.ts,
 * así que cualquier cambio de diseño/lógica futuro aplica acá sin duplicar.
 *
 * Sin argumentos: la tarjeta de hoy. Con una o más fechas (YYYY-MM-DD),
 * manda una tarjeta por fecha, en orden: `npm run kpi-card:send-now -- 2026-07-19 2026-07-18`.
 */
async function main(): Promise<void> {
  const notionToken = process.env.NOTION_TOKEN;
  const botToken = process.env.COS_TELEGRAM_BOT_TOKEN;

  if (!notionToken || !botToken) {
    console.error("Faltan NOTION_TOKEN y/o COS_TELEGRAM_BOT_TOKEN en el entorno (~/.cos-agent/.env o ~/.claude/secrets/apps.env).");
    process.exit(1);
  }

  const fechas = process.argv.slice(2);
  for (const fecha of fechas) {
    if (!FECHA_RE.test(fecha)) {
      console.error(`Fecha inválida "${fecha}" — usar formato YYYY-MM-DD.`);
      process.exit(1);
    }
  }

  // Mismo chat_id que ALERT_CHAT_ID en index.ts (Cal).
  for (const fecha of fechas.length ? fechas : [undefined]) {
    await checkKpiCardDaily({ botToken, chatId: 94137698, notionToken, fecha });
  }
  console.log("Listo — revisa Telegram (llega la tarjeta, o un texto de error si algo falló).");
}

main();
