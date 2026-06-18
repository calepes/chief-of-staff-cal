import type { WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import type { FuelEvent } from "@cos/shared";
import { sendMessage } from "@cos/shared";
import { runAgent } from "../agent.js";

const STATUS_URL = "https://combustible-proxy.carlos-cb4.workers.dev/monitor/status";

export interface FuelAlertDeps {
  takeWarm: () => Promise<WarmQuery>;
  setCurrentChatId: (id: number) => void;
  chatId: number;
  botToken: string;
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
  return `Eres Jano. Formato: Telegram HTML (solo <b>, <i>, <a href>). Español neutro. Sin acks genéricos.

EVENTO PROACTIVO: llegó gasolina a estaciones que Cal monitorea.

Estaciones (ya verificadas como disponibles):
${lines.join("\n")}

IMPORTANTE: NO llames ninguna herramienta. Tu respuesta de texto ES el mensaje que se le envía a Cal (el sistema lo manda automáticamente). Solo escribe el texto, nada más.

Redáctalo así:
- Una línea por estación: emoji ⛽🟢 (si tipo=alert) o ⛽🔔 (si tipo=reminder), el nombre en <b>negrita</b>, los litros, y <a href="LINK">Cómo llegar</a> usando el link de navegación.
- Cierra con una frase corta: "Escríbeme si quieres ver o ajustar el menú de estaciones."
- Sin párrafos largos, sin inventar estaciones fuera de la lista.`;
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
    const result = await runAgent(buildPrompt(fresh), { warm, history: [] });
    const reply = (result?.reply || "").trim();
    if (reply) {
      // El daemon entrega el texto del agente (mismo patrón que el flujo reactivo);
      // el agente NO tiene tool de envío en este turno. Fallback a texto plano si el HTML falla.
      await sendMessage(deps.botToken, { chatId: deps.chatId, text: reply, parseMode: "HTML" }).catch(() =>
        sendMessage(deps.botToken, { chatId: deps.chatId, text: reply }).catch(() => {}),
      );
      console.log(JSON.stringify({ ts: Date.now(), msg: "fuel_alert_sent", names: fresh.map((e) => e.name) }));
    } else {
      console.log(JSON.stringify({ ts: Date.now(), msg: "fuel_alert_empty_reply", names: fresh.map((e) => e.name) }));
    }
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "fuel_alert_agent_error", err: String(err) }));
  }
}
