import type { EntityConfig } from "./research-competencia-entities.js";
import type { MetaAdCreative } from "./research-competencia-meta-ads.js";
import type { AdsKpis } from "./research-competencia-types.js";

/**
 * Inteligencia de PUBLICIDAD, complementaria al scraping de contenido orgánico
 * (research-competencia-social.ts). No lo reemplaza: responden preguntas distintas — el orgánico
 * dice qué comunica la marca a sus seguidores, el publicitario dice en qué está gastando y a quién
 * le habla.
 *
 * Fuente: Google Ads Transparency Center. Elegida tras verificar en vivo (2026-09-03) que las
 * alternativas NO sirven para Bolivia:
 *   - Ad Library API oficial de Meta: fuera de UK/UE solo devuelve anuncios políticos, y exige
 *     confirmación de identidad. Cerrada para este caso.
 *   - TikTok Creative Center / Commercial Content Library: Bolivia no está entre los países
 *     cubiertos (LatAm = solo AR/BR/CO/MX). `countryCode=BO` se ignora en silencio.
 *   - X Ads Repository: solo los 27 de la UE.
 * Google, en cambio, expone `region=BO` con búsqueda por anunciante y sin login ni token.
 *
 * ⚠️ Endpoint NO OFICIAL (RPC interno del Transparency Center). Va a romperse en algún momento:
 * cuando eso pase el síntoma es `research_competencia_ads_http` con un status raro o
 * `research_competencia_ads_parse_failed`, NO una excepción — el research sigue corriendo sin este
 * bloque, igual que hace con el social.
 *
 * ⚠️ Rate limit real, más duro de lo que `THROTTLE_MS` puede mitigar — confirmado en vivo
 * 2026-09-03/04: tras el volumen de pedidos del descubrimiento manual de IDs + 2 corridas reales
 * de prueba (~40-50 requests en el día), Google devolvió 429 en TODO `adstransparency.google.com`
 * — no solo el RPC, la página HTML plana también — y seguía bloqueado 20+ horas después. Es un
 * baneo de IP a nivel dominio, no un throttle de ráfaga: ningún espaciado entre pedidos DENTRO de
 * una corrida lo evita, porque el umbral que lo dispara vive en un acumulado de horas/días, no en
 * la velocidad de una sola corrida. `THROTTLE_MS` sigue teniendo sentido (evita el caso fácil de
 * ráfaga), pero no es una garantía. El uso real (cron semanal, ~7 pedidos con throttle) es un
 * volumen muchísimo menor al que disparó el bloqueo — probablemente seguro en la práctica — pero
 * sin forma de confirmarlo sin esperar semanas de corridas reales. Sin mitigación adicional
 * implementada a propósito: no hay fix técnico real contra un bloqueo de IP opaco de un endpoint
 * no documentado, y agregar reintentos/backoff no ayuda contra una ventana de horas.
 */

/** Código de región de Bolivia en el Transparency Center (verificado en vivo: `region=BO` → 2068). */
const REGION_BOLIVIA = 2068;

const SEARCH_CREATIVES_URL = "https://adstransparency.google.com/anji/_/rpc/SearchService/SearchCreatives?authuser=";

/**
 * Espera entre pedidos consecutivos. NO es cortesía opcional: el endpoint devuelve HTTP 429 con un
 * body HTML (no JSON) tras unos pocos pedidos seguidos — reproducido en vivo el 2026-09-03 haciendo
 * 4 consultas sin pausa. Con 6 entidades y ~1 anunciante cada una, 2,5 s de espaciado agrega ~15 s
 * a una corrida semanal que ya dura decenas de minutos: intercambio irrelevante a cambio de no
 * perder el bloque entero por rate limit.
 *
 * Exportado (antes privado) para que el test de este archivo pueda verificar el espaciado real sin
 * hardcodear el valor por separado.
 */
export const THROTTLE_MS = 2_500;

/**
 * Cola global A NIVEL MÓDULO (Tarea 3b, `runResearchCompetencia` paraleliza hasta 3 entidades en
 * simultáneo — ver research-competencia.ts) — serializa TODOS los pedidos reales a
 * `fetchAdvertiserReal`, sin importar de qué entidad (o llamada a `fetchAdsText`) vengan.
 *
 * Sin esto, el `THROTTLE_MS` de arriba solo espaciaba pedidos DENTRO de una misma llamada (entre
 * los distintos `advertiserId` de UNA entidad) — con 3 entidades corriendo a la vez, sus PRIMEROS
 * pedidos (que antes no esperaban nada, por diseño: no hay que throttlear antes del primero de una
 * llamada) podían salir casi simultáneos entre sí, exactamente el patrón de ráfaga que ya causó el
 * bloqueo real de 20+ horas documentado arriba. La cola global los serializa a TODOS por igual —
 * ya no importa si el pedido es "el primero" de su propia llamada, importa que sea el próximo en la
 * cola compartida.
 *
 * Patrón: promesa encadenada a nivel módulo. Cada pedido nuevo se cuelga del final de la cola
 * (`colaGlobalAds`), corre en cuanto le toca el turno, y el turno SIGUIENTE no puede arrancar hasta
 * `THROTTLE_MS` después de que este termine (`esperar` inyectable, mismo mecanismo que ya usaba
 * `fetchAdsText` — así el test puede verificar el espaciado sin dormir de verdad). No bloquea el
 * resto del pipeline de cada entidad: `conColaGlobal` devuelve el resultado del pedido en sí
 * (`miTurno`), no la espera posterior — quien sigue en la cola es el único que la paga.
 */
let colaGlobalAds: Promise<void> = Promise.resolve();

function conColaGlobal<T>(ms: number, esperar: (ms: number) => Promise<void>, pedido: () => Promise<T>): Promise<T> {
  const miTurno = colaGlobalAds.then(pedido, pedido);
  colaGlobalAds = miTurno.then(
    () => esperar(ms),
    () => esperar(ms), // un pedido fallido igual respeta el espaciado antes del próximo
  );
  return miTurno;
}

/** Tope de creativos pedidos por anunciante — el mismo `40` que usa la UI del Transparency Center. */
const MAX_CREATIVES_PER_ADVERTISER = 40;

// Topes de tamaño del bloque de texto, en línea con research-competencia-social.ts (que usa
// 20.000 para el suyo). El bloque de ads es mucho más chico por naturaleza — una línea por
// creativo, sin transcripciones ni descripciones de visión — así que 8.000 alcanza de sobra para
// varias decenas de anuncios sin competirle espacio al bloque social dentro del mismo prompt.
const MAX_TOTAL_CHARS = 8_000;
const MAX_FIELD_CHARS = 200;

export interface AdCreative {
  advertiserId: string;
  advertiserName: string;
  creativeId: string;
  /** ISO (YYYY-MM-DD) en hora Bolivia; null si el campo no vino o no es parseable. */
  primeraVez: string | null;
  /** ISO (YYYY-MM-DD) en hora Bolivia; null si el campo no vino o no es parseable. */
  ultimaVez: string | null;
  /** Dominio de destino del anuncio, si el creativo lo declara. */
  dominio: string | null;
  /** Etiqueta derivada de la FORMA del payload, no de un código numérico sin documentar (ver parseGoogleCreatives). */
  formato: "imagen" | "display" | "desconocido";
  /** Permalink citable en el Transparency Center — es la `fuente` que va al hallazgo. */
  url: string;
}

/**
 * Convierte epoch en segundos a fecha ISO (YYYY-MM-DD) en hora de Bolivia (UTC-4, sin DST).
 *
 * El `slice(0,10)` sobre un `toISOString()` pelado daría el día en UTC — para cualquier timestamp
 * entre las 20:00 y medianoche hora local eso fechea al día siguiente. Es el mismo gotcha
 * documentado en el CLAUDE.md del repo (pisado 4 veces en otros pipelines) y el mismo criterio de
 * offset fijo que usa `parseFechaLaPaz` en research-competencia-social.ts.
 */
export function epochToLaPazDate(epochSeconds: unknown): string | null {
  const n = typeof epochSeconds === "string" ? Number(epochSeconds) : epochSeconds;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  const d = new Date((n - 4 * 3600) * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/**
 * Deriva el formato del creativo mirando la FORMA del payload, no el código numérico del campo 4.
 * Ese código existe (se observaron los valores 2 y 3 en vivo) pero no está documentado en ningún
 * lado y adivinar su semántica produciría etiquetas plausibles y falsas — justo el tipo de dato
 * que después se cita como hecho en un battlecard. La forma del payload sí es evidencia directa:
 * un `<img>` embebido es una imagen, un preview `content.js` es un display ad servido por Google.
 */
function derivarFormato(creativo: Record<string, unknown> | null): AdCreative["formato"] {
  if (!creativo) return "desconocido";
  const html = asRecord(creativo["3"])?.["2"];
  if (typeof html === "string" && html.includes("<img")) return "imagen";
  if (asRecord(creativo["1"])?.["4"]) return "display";
  return "desconocido";
}

/**
 * Parsea la respuesta cruda del RPC a `AdCreative[]`. Pura y separada del fetch a propósito: es la
 * parte que se rompe cuando Google cambia la forma del payload, y así se puede testear con
 * fixtures sin tocar la red.
 *
 * Fail-soft por ítem: un creativo con forma inesperada se descarta en silencio en vez de tirar la
 * respuesta entera — en un cron desatendido, perder 1 de 40 anuncios es mucho mejor que perder los
 * 40 porque uno traía un campo raro.
 */
export function parseGoogleCreatives(raw: unknown): AdCreative[] {
  const items = asRecord(raw)?.["1"];
  if (!Array.isArray(items)) return [];
  const out: AdCreative[] = [];
  for (const item of items) {
    const it = asRecord(item);
    if (!it) continue;
    const advertiserId = it["1"];
    const creativeId = it["2"];
    if (typeof advertiserId !== "string" || typeof creativeId !== "string") continue;
    const advertiserName = typeof it["12"] === "string" ? it["12"] : "(anunciante sin nombre)";
    const dominio = typeof it["14"] === "string" ? it["14"] : null;
    out.push({
      advertiserId,
      creativeId,
      advertiserName,
      primeraVez: epochToLaPazDate(asRecord(it["6"])?.["1"]),
      ultimaVez: epochToLaPazDate(asRecord(it["7"])?.["1"]),
      dominio,
      formato: derivarFormato(asRecord(it["3"])),
      url: `https://adstransparency.google.com/advertiser/${advertiserId}/creative/${creativeId}?region=BO`,
    });
  }
  return out;
}

/**
 * Deja los anuncios relevantes para la ventana. Un anuncio entra si SIGUE ACTIVO en la ventana
 * (`ultimaVez` dentro) o si ARRANCÓ en ella (`primeraVez` dentro).
 *
 * Los dos criterios responden preguntas distintas y las dos importan: `primeraVez` dentro de la
 * ventana es una campaña NUEVA (la señal más fuerte para inteligencia competitiva), mientras que
 * `ultimaVez` dentro dice que la campaña sigue viva ahora mismo. Un anuncio sin ninguna fecha
 * parseable se conserva, mismo criterio que `filterPostsByTimeframe` en el módulo social: descartar
 * por falta de metadato perdería contenido real.
 */
export function filterAdsByTimeframe(ads: AdCreative[], timeframeDias: number, ahora = new Date()): AdCreative[] {
  const desde = new Date(ahora.getTime() - timeframeDias * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return ads.filter((a) => {
    if (!a.primeraVez && !a.ultimaVez) return true;
    return (a.ultimaVez ?? "") >= desde || (a.primeraVez ?? "") >= desde;
  });
}

/** Marca si el anuncio ARRANCÓ dentro de la ventana — la señal de "campaña nueva". */
export function esNuevo(ad: AdCreative, timeframeDias: number, ahora = new Date()): boolean {
  if (!ad.primeraVez) return false;
  return ad.primeraVez >= new Date(ahora.getTime() - timeframeDias * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Colapsa saltos de línea y recorta. Mismo razonamiento que `sanitizeField` en el módulo social, y
 * no es cosmético: `advertiserName` y `dominio` son contenido de terceros insertado tal cual en el
 * bloque. Sin colapsar los saltos, un nombre de anunciante con `\n` podría fabricar una línea
 * `[ads ...] https://url-falsa` indistinguible de una real para el LLM, rompiendo la garantía de
 * que toda URL citada es verificable.
 */
function sanitizeField(s: string, max = MAX_FIELD_CHARS): string {
  const oneLine = s.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * Arma el bloque de texto para el prompt. Una línea por anuncio, encabezada por la URL citable —
 * mismo contrato que `formatSocialText`: el LLM tiene que poder copiar esa URL como `fuente` de un
 * hallazgo sin inventarla.
 */
export function formatAdsText(ads: AdCreative[], timeframeDias: number, ahora = new Date()): string {
  if (ads.length === 0) return "";
  const lineas = ads.map((a) => {
    const partes = [
      `[google-ads · ${sanitizeField(a.advertiserName)}${a.dominio ? ` · ${sanitizeField(a.dominio, 80)}` : ""}] ${a.url}`,
      `Formato: ${a.formato}`,
      `Publicado: ${a.primeraVez ?? "?"} → ${a.ultimaVez ?? "?"}`,
    ];
    if (esNuevo(a, timeframeDias, ahora)) partes.push("CAMPAÑA NUEVA en esta ventana");
    return partes.join(" · ");
  });
  const texto = lineas.join("\n");
  return texto.length > MAX_TOTAL_CHARS
    ? `${texto.slice(0, MAX_TOTAL_CHARS)}\n[...truncado — se alcanzó el límite de ${MAX_TOTAL_CHARS} caracteres]`
    : texto;
}

export type AdsFetcher = (advertiserId: string) => Promise<unknown | null>;

export interface FetchAdsDeps {
  /** Inyectable para testear sin red. Default: el RPC real del Transparency Center. */
  fetchAdvertiser?: AdsFetcher;
  /** Espera entre anunciantes (ms). Inyectable para que los tests no duerman de verdad. */
  esperar?: (ms: number) => Promise<void>;
  ahora?: Date;
}

/**
 * Consulta el RPC real. Devuelve null (nunca tira) ante cualquier problema — rate limit, cambio de
 * contrato, red caída: este bloque es complementario, y una falla suya no puede tumbar el research
 * de la entidad. Los dos modos de falla se loguean distinto a propósito (`_http` vs
 * `_parse_failed`): el primero es "Google nos frenó o cambió el endpoint", el segundo es "responde
 * pero ya no en JSON" — típicamente el HTML de un challenge anti-bot. Diagnósticos distintos.
 */
async function fetchAdvertiserReal(advertiserId: string): Promise<unknown | null> {
  const body = new URLSearchParams({
    "f.req": JSON.stringify({
      2: MAX_CREATIVES_PER_ADVERTISER,
      3: { 8: [REGION_BOLIVIA], 12: { 1: "", 2: true }, 13: { 1: [advertiserId] } },
      7: { 1: 1, 2: 0, 3: REGION_BOLIVIA },
    }),
  });
  let res: Response;
  try {
    res = await fetch(SEARCH_CREATIVES_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-same-domain": "1" },
      body,
    });
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_ads_fetch_error", advertiserId, err: String(err) }));
    return null;
  }
  const txt = await res.text();
  if (!res.ok) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_ads_http", advertiserId, status: res.status }));
    return null;
  }
  try {
    return JSON.parse(txt);
  } catch {
    console.log(JSON.stringify({
      ts: Date.now(),
      msg: "research_competencia_ads_parse_failed",
      advertiserId,
      hint: "respuesta no-JSON — probablemente un challenge anti-bot o un cambio de contrato del RPC",
      muestra: txt.slice(0, 200),
    }));
    return null;
  }
}

export interface FetchAdsResult {
  texto: string | null;
  /** Creativos YA filtrados por ventana — mismo dato que arma `texto`, expuesto aparte para que el
   * orquestador calcule KPIs comparables (`computeAdsKpis`) sin repetir el fetch de red. */
  creativos: AdCreative[];
}

/**
 * Bloque de texto de publicidad para una entidad, MÁS los creativos crudos que lo componen.
 * `texto` es null si la entidad no declara anunciantes o si no se recuperó ningún anuncio — mismo
 * contrato que `fetchSocialText`, para que el orquestador los trate igual; `creativos` es siempre
 * un array (vacío si no hubo nada), nunca null, porque "cero actividad" es un dato válido para
 * `computeAdsKpis`.
 */
export async function fetchAdsText(
  entity: EntityConfig,
  timeframeDias: number,
  deps: FetchAdsDeps = {},
): Promise<FetchAdsResult> {
  const advertisers = entity.ads?.google ?? [];
  if (advertisers.length === 0) return { texto: null, creativos: [] };

  const fetchAdvertiser = deps.fetchAdvertiser ?? fetchAdvertiserReal;
  const esperar = deps.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ahora = deps.ahora ?? new Date();

  const todos: AdCreative[] = [];
  for (const advertiserId of advertisers) {
    // Espaciado vía la cola GLOBAL (`conColaGlobal`), no un `if (i>0)` local — con entidades
    // corriendo en paralelo (Tarea 3b), el throttle tiene que aplicar entre TODAS las llamadas a
    // `fetchAdsText`, no solo entre los anunciantes de esta.
    const raw = await conColaGlobal(THROTTLE_MS, esperar, () => fetchAdvertiser(advertiserId));
    if (raw === null) continue;
    const creativos = parseGoogleCreatives(raw);
    if (creativos.length === 0) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_ads_empty", entityId: entity.id, advertiserId }));
      continue;
    }
    todos.push(...filterAdsByTimeframe(creativos, timeframeDias, ahora));
  }

  return { texto: formatAdsText(todos, timeframeDias, ahora) || null, creativos: todos };
}

/**
 * KPIs comparables de actividad publicitaria entre las 6 entidades — ver el docstring de `AdsKpis`
 * (research-competencia-types.ts) sobre por qué son proxies de volumen, no de gasto. `google` y
 * `meta` ya vienen filtrados/deduplicados por sus respectivos `fetch*Text` (mismos arrays que
 * arman el texto del prompt) — esta función solo agrega, no vuelve a tocar red.
 *
 * `duracionPromedioDias` clampea cada duración individual a >= 0: `filterAdsByTimeframe` conserva
 * a propósito creativos con `ultimaVez < primeraVez` (dato inconsistente del RPC, ver su test) —
 * sin el clamp, uno solo de esos arrastraría el promedio hacia abajo con una duración negativa sin
 * sentido de negocio.
 */
export function computeAdsKpis(
  google: AdCreative[],
  meta: MetaAdCreative[],
  timeframeDias: number,
  ahora = new Date(),
): AdsKpis {
  const desdeCorte = new Date(ahora.getTime() - timeframeDias * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const nuevosGoogle = google.filter((a) => esNuevo(a, timeframeDias, ahora)).length;
  const nuevosMeta = meta.filter((a) => a.desde !== null && a.desde >= desdeCorte).length;

  const duraciones = google
    .filter((a): a is AdCreative & { primeraVez: string; ultimaVez: string } => !!a.primeraVez && !!a.ultimaVez)
    .map((a) => Math.max(0, (new Date(a.ultimaVez).getTime() - new Date(a.primeraVez).getTime()) / (24 * 60 * 60 * 1000)));
  const duracionPromedioDias = duraciones.length > 0
    ? Math.round((duraciones.reduce((sum, d) => sum + d, 0) / duraciones.length) * 10) / 10
    : null;

  const mixFormato = { imagen: 0, display: 0, desconocido: 0 };
  for (const a of google) mixFormato[a.formato]++;

  return {
    creativosActivos: google.length + meta.length,
    campanasNuevas: nuevosGoogle + nuevosMeta,
    google: { nuevos: nuevosGoogle, existentes: google.length - nuevosGoogle },
    meta: { nuevos: nuevosMeta, existentes: meta.length - nuevosMeta },
    duracionPromedioDias,
    mixFormato,
  };
}
