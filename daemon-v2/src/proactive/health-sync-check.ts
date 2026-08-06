import type { CfKv } from "../cf-kv.js";
import { sendCronMessage } from "./rich-send.js";

const STATUS_URL = "https://health.carlos-cb4.workers.dev/status";
const TIMEOUT_MS = 8000;
const ALERT_DEDUP_KEY = "health_sync_alert:active";
const ALERT_DEDUP_TTL_SEC = 24 * 60 * 60;

export interface HealthSyncCheckOpts {
  kv: CfKv;
  botToken: string;
  chatId: number;
  apiKey: string;
  thresholdHours: number;
}

interface HealthStatus {
  lastIngestAt: string | null;
  hoursSinceLastIngest: number | null;
}

export async function checkHealthSync(opts: HealthSyncCheckOpts): Promise<void> {
  const { kv, botToken, chatId, apiKey, thresholdHours } = opts;

  let status: HealthStatus;
  try {
    const res = await fetch(`${STATUS_URL}?key=${encodeURIComponent(apiKey)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    status = (await res.json()) as HealthStatus;
  } catch (err) {
    // Fallo nuestro consultando el status (no del sync en sí) — no alertar, solo loguear.
    console.log(JSON.stringify({ ts: Date.now(), msg: "health_sync_check_error", err: String(err) }));
    return;
  }

  const { hoursSinceLastIngest, lastIngestAt } = status;

  try {
    const alreadyAlerted = await kv.get<boolean>(ALERT_DEDUP_KEY);

    if (hoursSinceLastIngest == null || hoursSinceLastIngest >= thresholdHours) {
      if (alreadyAlerted) return; // ya avisado para este corte, esperar a que se resuelva

      const desc = hoursSinceLastIngest == null
        ? "nunca llegó data registrada"
        : `hace ${hoursSinceLastIngest}h (último dato: ${lastIngestAt})`;
      const text = `⚠️ <b>Corte de sync de Apple Health</b>\nNo llega data de Health Auto Export — ${desc}.\nRevisa Background App Refresh / Low Power Mode en tu teléfono, o abre la app para forzar el sync.`;

      let sent = false;
      try {
        await sendCronMessage(botToken, { chatId, text });
        sent = true;
      } catch (err) {
        console.log(JSON.stringify({ ts: Date.now(), msg: "health_sync_alert_send_failed", err: String(err) }));
      }

      // Solo marcar "ya avisado" si el mensaje realmente salió — si Telegram falló,
      // dejar el flag sin marcar para reintentar en el próximo tick (30 min).
      if (sent) {
        await kv.set(ALERT_DEDUP_KEY, true, ALERT_DEDUP_TTL_SEC);
        console.log(JSON.stringify({ ts: Date.now(), msg: "health_sync_alert_sent", hoursSinceLastIngest }));
      }
    } else if (alreadyAlerted) {
      // Volvió a sincronizar — limpiar el flag para que un corte futuro re-avise.
      await kv.delete(ALERT_DEDUP_KEY);
      console.log(JSON.stringify({ ts: Date.now(), msg: "health_sync_alert_cleared" }));
    }
  } catch (err) {
    // Fallo de la API de KV (no del sync en sí) — loguear y salir sin dejar escapar
    // la excepción (el caller la invoca vía `void` en un cron callback).
    console.log(JSON.stringify({ ts: Date.now(), msg: "health_sync_check_kv_error", err: String(err) }));
  }
}
