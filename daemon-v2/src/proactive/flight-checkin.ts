import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { startup } from "@anthropic-ai/claude-agent-sdk";
import type { CfKv } from "../cf-kv.js";
import { runAgent } from "../agent.js";
import { sendMessage } from "@cos/shared";

interface FlightCheckinOpts {
  kv: CfKv;
  botToken: string;
  chatId: number;
  options: Options;
}

interface Flight {
  code: string;
  route: string;
  time: string;
  hours_until: number;
}

export async function checkFlightCheckin(opts: FlightCheckinOpts): Promise<void> {
  const { kv, botToken, chatId, options } = opts;

  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  let warm;
  try {
    warm = await startup({ options });
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "flight_checkin_startup_error", err: String(err) }));
    return;
  }

  const prompt = `Consulta Google Calendar calendario "AntoCataNoeCal" (id c_4c2ogsnda3b61k1sd9eta6vc2k@group.calendar.google.com) con mcp__claude_ai_Google_Calendar__list_events, rango ${now} a ${future}.

Para cada evento encontrado, extrae el booking code si existe (6 caracteres alfanuméricos en mayúsculas, ej: XYZ123).

Devuelve SOLO un JSON array con los vuelos que tienen booking code:
[{"code": "XYZ123", "route": "VVI-LIM", "time": "06:15", "hours_until": 14}]

Si no hay vuelos con booking code, devuelve: []

Solo JSON, sin explicaciones.`;

  let reply: string;
  try {
    ({ reply } = await runAgent(prompt, { warm, history: [] }));
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "flight_checkin_agent_error", err: String(err) }));
    return;
  }

  const match = reply.match(/\[.*\]/s);
  if (!match) return;

  let flights: Flight[];
  try {
    flights = JSON.parse(match[0]) as Flight[];
  } catch {
    return;
  }

  if (!Array.isArray(flights) || flights.length === 0) return;

  const newFlights: Flight[] = [];
  for (const f of flights) {
    if (!f.code) continue;
    const kvKey = `flight_checkin_seen:${today}:${f.code}`;
    const seen = await kv.get<boolean>(kvKey);
    if (!seen) {
      await kv.set(kvKey, true, 86400);
      newFlights.push(f);
    }
  }

  if (newFlights.length === 0) return;

  const lines = newFlights.map((f) => {
    const urgent = f.hours_until < 2 ? " ⚠️ urgente" : "";
    return `- ${f.route} ${f.time} (booking: ${f.code}, sale en ${Math.round(f.hours_until)}h)${urgent}`;
  });

  await sendMessage(botToken, {
    chatId,
    text: `✈️ Check-in pendiente:\n${lines.join("\n")}`,
  });

  console.log(JSON.stringify({ ts: Date.now(), msg: "flight_checkin_alert_sent", count: newFlights.length }));
}
