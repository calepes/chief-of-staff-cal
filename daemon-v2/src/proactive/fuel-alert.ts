import type { WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import type { FuelEvent } from "@cos/shared";
import { runAgent } from "../agent.js";

const STATUS_URL = "https://combustible-proxy.carlos-cb4.workers.dev/monitor/status";

export interface FuelAlertDeps {
  takeWarm: () => Promise<WarmQuery>;
  setCurrentChatId: (id: number) => void;
  chatId: number;
}

// Re-verifica litros actuales; devuelve solo eventos cuya estación sigue disponible.
async function filterFresh(events: FuelEvent[]): Promise<FuelEvent[]> {
  try {
    const resp = await fetch(STATUS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return events; // si el status falla, no descartar (mejor avisar que perder)
    const { stations } = (await resp.json()) as { stations: { name: string; available: boolean; litros: number }[] };
    const avail = new Map(stations.map((s) => [s.name, s]));
    // Log defensivo: si el nombre del evento no matchea ninguna estación del status,
    // se descarta silenciosamente (fail-closed por mismatch de nombre, no por error).
    for (const ev of events) {
      if (!avail.has(ev.name)) {
        console.log(JSON.stringify({ ts: Date.now(), msg: "fuel_alert_name_unmatched", name: ev.name }));
      }
    }
    return events
      .filter((ev) => avail.get(ev.name)?.available)
      .map((ev) => ({ ...ev, litros: avail.get(ev.name)?.litros ?? ev.litros }));
  } catch {
    return events;
  }
}

function buildPrompt(events: FuelEvent[]): string {
  const lines = events.map((ev) => {
    const litros = ev.litros.toLocaleString("es-BO");
    const nav = ev.waze || `https://www.google.com/maps/search/?api=1&query=${ev.lat},${ev.lon}`;
    return `- ${ev.name} (${ev.company}) — ~${litros} L · tipo:${ev.kind} · navegar:${nav}`;
  });
  return `Eres Jano. Formato: Telegram HTML. Español neutro. Sin acks genéricos.

EVENTO PROACTIVO: llegó gasolina a estaciones que Cal monitorea. Avísale AHORA con un mensaje corto y visual.

Estaciones (ya verificadas como disponibles):
${lines.join("\n")}

Tu tarea en este turno:
1. Por cada estación, envía una línea: emoji ⛽🟢 (alert) o ⛽🔔 (reminder), nombre en <b>negrita</b>, litros, y un <a href="...">Cómo llegar</a> con el link de navegación.
2. Cierra ofreciendo: "¿Quieres ver/ajustar el menú de estaciones monitoreadas?" — si Cal dice que sí, usa getFuelMonitorStatus y arma el menú con toggles.
3. No inventes estaciones fuera de la lista. Una sola tanda de mensajes, sin párrafos largos.`;
}

export async function processFuelAlert(events: FuelEvent[], deps: FuelAlertDeps): Promise<void> {
  const fresh = await filterFresh(events);
  if (fresh.length === 0) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "fuel_alert_all_stale", count: events.length }));
    return;
  }
  deps.setCurrentChatId(deps.chatId);
  let warm;
  try {
    warm = await deps.takeWarm();
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "fuel_alert_startup_error", err: String(err) }));
    return;
  }
  try {
    await runAgent(buildPrompt(fresh), { warm, history: [] });
    console.log(JSON.stringify({ ts: Date.now(), msg: "fuel_alert_sent", names: fresh.map((e) => e.name) }));
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "fuel_alert_agent_error", err: String(err) }));
  }
}
