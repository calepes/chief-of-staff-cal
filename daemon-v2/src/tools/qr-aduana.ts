// QR Aduana Bolivia — Formulario N° 250 (Declaración Jurada de Equipaje y Divisas).
// Genera el QR de salida/ingreso vía un POST HTTP directo (sin navegador) y lo manda al chat.
// Flujo HTTP validado 2026-06-21: ver ~/.claude/skills/qr-aduana-bolivia/references/http-flow.md
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";

const BASE = "http://anbsw01.aduana.gob.bo:7401/viajero";
const TRAVELERS_PATH = join(homedir(), ".claude", "datos-viaje.json");

export interface Traveler {
  nombres: string;
  apellido1: string;
  apellido2: string;
  sexo: "M" | "F";
  fechaNacimiento: string; // DD/MM/YYYY
  nacionalidad: "B" | "E";
  paisNacionalidad: string; // ISO-2 (cuando E)
  docTipo: "p" | "c" | "cie" | "o";
  docEspecifique: string; // cuando docTipo = "o"
  docNumero: string;
  ocupacion: string;
  alias?: string[];
  boaViajeroFrecuente?: string;
}

const MOTIVO_MAP: Record<string, string> = {
  turismo: "T", "turismo o visita": "T", visita: "T",
  salud: "S",
  trabajo: "N",
  retorno: "R",
  otros: "O", otro: "O",
};

export function resolveTraveler(name: string): Traveler | null {
  let data: { viajeros?: Record<string, Traveler> };
  try {
    data = JSON.parse(readFileSync(TRAVELERS_PATH, "utf8"));
  } catch {
    return null;
  }
  const viajeros = data.viajeros || {};
  const key = name.trim().toLowerCase();
  if (viajeros[key]) return viajeros[key];
  for (const t of Object.values(viajeros)) {
    if ((t.alias || []).some((a) => a.toLowerCase() === key)) return t;
  }
  // match por nombre de pila
  for (const t of Object.values(viajeros)) {
    if (`${t.nombres} ${t.apellido1}`.toLowerCase().includes(key)) return t;
  }
  return null;
}

export function listTravelerKeys(): string[] {
  try {
    const data = JSON.parse(readFileSync(TRAVELERS_PATH, "utf8"));
    return Object.keys(data.viajeros || {});
  } catch {
    return [];
  }
}

/** Número de viajero frecuente (Elévate/BoA) guardado para un viajero, si existe. */
export function getBoaFrequentFlyer(name: string): string | null {
  const t = resolveTraveler(name);
  return t?.boaViajeroFrecuente ?? null;
}

export interface QrTripArgs {
  tipoViaje: "salida" | "ingreso";
  pais: string; // ISO-2 destino (salida) o procedencia (ingreso)
  transporte: string; // AVIÓN | BUS | VEHÍCULO PARTICULAR | TRANSPORTE DE CARGA | A PIE | OTROS
  empresa?: string;
  vuelo?: string;
  motivo: string; // etiqueta o código
  divisas?: boolean; // efectivo entre $10k-$20k
  montoUsd?: string;
}

export interface QrResult {
  ok: boolean;
  memorizado?: string;
  qrData?: string;
  error?: string;
}

async function getSessionCookie(): Promise<string> {
  try {
    const r = await fetch(`${BASE}/ResPublico.do`, { redirect: "manual" });
    const set = (r.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
      [r.headers.get("set-cookie") || ""];
    for (const c of set) {
      const m = c.match(/JSESSIONID=[^;]+/);
      if (m) return m[0];
    }
  } catch {
    /* el POST puede funcionar sin cookie; seguimos */
  }
  return "";
}

/** Hace el POST al Form 250 y devuelve { ok, memorizado, qrData }. */
export async function generarQrAduana(t: Traveler, trip: QrTripArgs): Promise<QrResult> {
  const tipoDivisa = trip.tipoViaje === "ingreso" ? "I" : "S";
  const motivoCode = MOTIVO_MAP[trip.motivo.trim().toLowerCase()] ?? trip.motivo.toUpperCase().slice(0, 1);

  const p = new URLSearchParams();
  const add = (k: string, v: string) => p.append(k, v);
  add("tipo_divisa", tipoDivisa);
  add("pais_procedencia", trip.pais.toUpperCase());
  add("propiosMediosOpcion", trip.transporte);
  add("transporte", trip.transporte);
  add("empresa_transporte", trip.empresa || "");
  add("vuelo_placa", trip.vuelo || "");
  add("propiosMedios", trip.transporte === "OTROS" ? trip.transporte : "");
  add("motivo_viaje", motivoCode);
  add("otro_motivo_viaje", "");
  add("nacionalidad", t.nacionalidad);
  add("viaNacionalidadExtranjero", t.nacionalidad === "E" ? t.paisNacionalidad.toUpperCase() : "");
  add("sexo", t.sexo);
  add("tipo_doc", t.docTipo);
  add("otro_tipo_doc", t.docTipo === "o" ? t.docEspecifique : "");
  add("nro_doc", t.docNumero);
  add("nombres", t.nombres);
  add("apellidos", t.apellido1);
  add("segundo_apellido", t.apellido2);
  add("viaFechaNacimiento", t.fechaNacimiento);
  add("viaOcupacion", t.ocupacion);
  // equipaje no se declara (en salida el paso se omite)
  add("equipaje", "N");
  add("tiene_equipaje", "N");
  add("cantidad_equipaje", "");
  add("tiene_articulos", "N");
  add("mercanciaEspecial", "N");
  add("mer_especial", "N");
  // divisas
  add("tiene_efectivo", trip.divisas ? "S" : "N");
  add("monto_usd", trip.divisas ? (trip.montoUsd || "") : "");
  add("opcion", "");
  add("observacion", "");

  const cookie = await getSessionCookie();
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (cookie) headers["Cookie"] = cookie;

  let text = "";
  try {
    const res = await fetch(`${BASE}/formPublico250.do`, {
      method: "POST",
      headers,
      body: p.toString(),
      signal: AbortSignal.timeout(20000),
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, error: `red: ${e instanceof Error ? e.message : String(e)}` };
  }

  const ok = /Formulario generado correctamente|memorizado=/i.test(text);
  if (!ok) {
    const idx = text.search(/Errores encontrados/i);
    const block = idx >= 0
      ? text.slice(idx, idx + 600).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      : "El servidor de la Aduana rechazó el formulario (sin detalle).";
    return { ok: false, error: block.slice(0, 300) };
  }
  const memorizado = (text.match(/memorizado=([0-9A-Za-z]+)/) || [])[1] || t.docNumero;
  const qrData = (text.match(/([SI]\|[^"'<\s]*WEB[^"'<\s]*)/) || [])[1] ||
    `${tipoDivisa}|${t.docNumero}||WEB:4.0|$`;
  return { ok: true, memorizado, qrData };
}

/** PNG del QR a partir del string que la Aduana codifica. */
export async function qrPngBuffer(qrData: string): Promise<Buffer> {
  return QRCode.toBuffer(qrData, { width: 600, margin: 2, errorCorrectionLevel: "M" });
}

/** Manda un buffer PNG como foto al chat (multipart, porque sendPhoto solo acepta URL/file_id). */
export async function enviarFotoBuffer(
  token: string,
  chatId: number | string,
  buf: Buffer,
  caption?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    if (caption) fd.append("caption", caption);
    fd.append("photo", new Blob([new Uint8Array(buf)], { type: "image/png" }), "qr-aduana.png");
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      body: fd,
      signal: AbortSignal.timeout(30000),
    });
    const data = (await res.json()) as { ok: boolean; description?: string };
    return data.ok ? { ok: true } : { ok: false, error: data.description };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const ImpresionUrl = (memorizado: string) => `${BASE}/Impresion250.jsp?memorizado=${memorizado}`;
