// lluvia-check.ts — orquestación diaria: fetch a lluvia-bolivia por las 3 ciudades,
// construye los 3 mensajes (lluvia-messages.ts) y los manda por Telegram. Dedup en CF
// KV para no duplicar si el daemon reinicia el mismo día. Mismo patrón que
// health-sync-check.ts (sin test propio — la lógica de branching real ya está cubierta
// por lluvia-messages.test.ts).

import type { CfKv } from "../cf-kv.js";
import { nowInLaPaz } from "../journal-capture.js";
import { sendCronMessage } from "./rich-send.js";
import { buildLluviaMessages, type CiudadDiaResultado } from "./lluvia-messages.js";

const LLUVIA_API = "https://lluvia-bolivia.carlos-cb4.workers.dev";
const TIMEOUT_MS = 10_000;
const CIUDADES = ["Santa Cruz (centro)", "Cochabamba", "La Paz"];
const DEDUP_TTL_SEC = 24 * 60 * 60;

interface DiaApiResponse {
  total: number | null;
  contexto?: { etiqueta: string; percentil: number | null; max_hist: number } | null;
}

async function fetchCiudadDia(ciudad: string, fecha: string): Promise<CiudadDiaResultado> {
  try {
    const url = `${LLUVIA_API}/api/dia?fecha=${encodeURIComponent(fecha)}&ciudad=${encodeURIComponent(ciudad)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ciudad, ok: false, total: null, error: `http ${res.status}` };
    const data = (await res.json()) as DiaApiResponse;
    return {
      ciudad,
      ok: true,
      total: data.total,
      categoria: data.contexto?.etiqueta ?? null,
      percentil: data.contexto?.percentil ?? null,
      maxHist: data.contexto?.max_hist ?? null,
    };
  } catch (err) {
    return { ciudad, ok: false, total: null, error: String(err) };
  }
}

export interface CheckLluviaOpts {
  kv: CfKv;
  botToken: string;
  chatId: number;
}

export async function checkLluvia(opts: CheckLluviaOpts): Promise<void> {
  const { kv, botToken, chatId } = opts;
  const fecha = nowInLaPaz().slice(0, 10);
  const dedupKey = `lluvia_check:${fecha}`;

  try {
    const yaCorrio = await kv.get<boolean>(dedupKey);
    if (yaCorrio) return;
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "lluvia_check_kv_read_error", err: String(err) }));
  }

  const resultados = await Promise.all(CIUDADES.map((c) => fetchCiudadDia(c, fecha)));
  const { reporte, confirmacion, alerta } = buildLluviaMessages(fecha, resultados);

  const mensajes = [reporte, confirmacion, alerta].filter((t): t is string => t !== null);
  let algunEnvioOk = false;
  for (const text of mensajes) {
    try {
      await sendCronMessage(botToken, { chatId, text });
      algunEnvioOk = true;
    } catch (err) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "lluvia_check_send_failed", err: String(err) }));
    }
  }

  // Se marca solo si AL MENOS UNO de los 3 envíos salió bien: si los 3 fallan (ej. el SNI
  // filtering que bloquea Telegram, documentado en Jano/CLAUDE.md), no se marca el dedup —
  // un reinicio del daemon ese mismo día vuelve a intentar los 3 mensajes desde cero. Es
  // intencional: perder los 3 mensajes en silencio por una falla total sería peor que, en el
  // caso raro de falla total + reinicio el mismo día, mandar algún mensaje duplicado.
  if (algunEnvioOk) {
    try {
      await kv.set(dedupKey, true, DEDUP_TTL_SEC);
    } catch (err) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "lluvia_check_kv_write_error", err: String(err) }));
    }
  } else {
    console.log(JSON.stringify({ ts: Date.now(), msg: "lluvia_check_all_sends_failed", fecha }));
  }
}
