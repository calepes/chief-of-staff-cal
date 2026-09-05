import { getEntity, ENTITIES } from "./research-competencia-entities.js";
import { fetchIosAppInfo, fetchAndroidAppInfo, fetchSiteText, chunkText } from "./research-competencia-sources.js";
import { buildEntityPrompt, runEntityAgent, parseAgentJson, type MechanicalFacts } from "./research-competencia-agent.js";
import { fetchSocialText } from "./research-competencia-social.js";
import { fetchAdsText } from "./research-competencia-ads.js";
import { openResearchBrowserSession, type ResearchBrowserSession } from "./research-competencia-browser.js";
import { readEntityState, writeEntityState, appendCambios, createInformePage } from "./research-competencia-notion.js";
import { nowInLaPaz } from "../journal-capture.js";
import type { EntityRunResult, RunResult } from "./research-competencia-types.js";

export interface RunOpts {
  timeframeDias?: number;
  entidadIds?: string[];
}

// Deadline duro del scraping social — carrera contra un timer, no un presupuesto chequeado entre
// iteraciones (eso no puede interrumpir un `await` colgado). `analyzePhoto` (vision.ts, fetch a
// OpenRouter) y `transcribeAudio` (whisper.ts, spawn de whisper-cli) NO tienen timeout propio —
// a diferencia de cada paso mecánico de la Fase 1 (page.goto 30s, ffmpeg 120s, descargas
// 30-120s), que sí. Un cuelgue de red en cualquiera de los dos dejaría la promesa sin resolver
// NI rechazar para siempre: el try/catch por entidad nunca dispara, la entidad traba el `for`
// secuencial de las 6, y con ella el informe de Notion y el mensaje de Telegram de la semana
// entera. 10 minutos porque una entidad con varios handles y videos puede tardar legítimamente
// varios minutos (enrichPosts documenta hasta "decenas de minutos" en el peor caso combinando
// descarga+ffmpeg+visión por post en research-competencia-social.ts) — tiene que cubrir ese caso
// real sin ser efectivamente infinito. Al vencer, la entidad sigue con socialText:null (logueado);
// el scraping abandonado sigue corriendo en background (Node no cancela promesas de verdad), pero
// nunca puede tirar sin capturar — va completo detrás de su propio `.catch()`.
//
// IMPORTANTE 3 (revisión de salud, 2026-09-03): tiene que ser MAYOR que `PER_ENTITY_BUDGET_MS`
// (research-competencia-social.ts) con margen real — ver el comentario ahí para la relación
// completa entre los dos. Subido de 8 a 10 min al mismo tiempo que `PER_ENTITY_BUDGET_MS` bajó de
// 10 a 7: antes el interno (10 min) NUNCA llegaba a dispararse porque este externo (8 min) siempre
// abandonaba la entidad primero — ahora el interno tiene 3 minutos reales para cortar prolijo
// antes de este hachazo. Exportado para que el test de este archivo (`research-competencia.test.ts`)
// no hardcodee el valor por separado y quede sincronizado si vuelve a ajustarse.
export const SOCIAL_TIMEOUT_MS = 10 * 60 * 1000;

// Deadline duro del agente LLM (`runEntityAgent`, research-competencia-agent.ts) — mismo motivo y
// mismo patrón (`Promise.race` contra un timer) que `SOCIAL_TIMEOUT_MS` de arriba. `runEntityAgent`
// solo tiene `maxTurns:20` como límite, y eso es un presupuesto de TURNOS que el SDK chequea ENTRE
// pasos — no protege contra un evento final que nunca llega (un WebSearch colgado, una partición
// de red, un deadlock del SDK): en ese caso el `for await (const event of handle.query(...))` de
// `runEntityAgent` espera indefinidamente y su `finally { handle.close() }` nunca corre. Como las
// 6 entidades corren secuencialmente, una sola atascada cuelga el proceso ENTERO para siempre, sin
// recuperación ni aviso — el mismo riesgo que el scraping social, sin la misma protección.
//
// 5 minutos: a diferencia del scraping social (descargas + ffmpeg + visión, minutos por post),
// `runEntityAgent` solo usa WebSearch — sin descargas pesadas ni transcripción. Una corrida real
// completó bien con más turnos de los que tenía el límite viejo del agente (12→20, ver el
// comentario de `runEntityAgent`), y una llamada de WebSearch individual no debería tardar
// minutos — 5 min da margen generoso sobre ese caso normal (varias búsquedas + una respuesta final)
// sin dejar una entidad trabada indefinidamente si el evento final nunca llega. Al vencer se trata
// igual que un `raw` vacío: error explícito de la entidad (el `Promise.race` rechaza, lo captura el
// try/catch de la entidad más abajo), nunca "sin hallazgos". Igual que el timeout social, esto NO
// cancela el `handle.query()` en curso — el proceso del SDK abandonado sigue corriendo en
// background hasta que él mismo termine o falle (Node no cancela promesas de verdad).
const AGENT_TIMEOUT_MS = 5 * 60 * 1000;

// Deadline del bloque de publicidad (research-competencia-ads.ts) — mismo patrón (`Promise.race`
// contra un timer) que el social y el del agente, por el mismo motivo: `fetch()` de Node no trae
// timeout propio, así que un `await` colgado ahí bloquearía el `for` secuencial de entidades para
// siempre. El caso normal es rápido (1-2 anunciantes por entidad, throttle de 2,5s entre pedidos,
// ver THROTTLE_MS en research-competencia-ads.ts) — sin descargas ni navegador de por medio, muy
// por debajo de lo que tarda el scraping social. 2 minutos cubre ese caso con margen generoso sin
// dejar una entidad colgada indefinidamente si Google deja de responder.
export const ADS_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Envuelve `promise` con un deadline que resuelve `null` y loguea `msg` si `promise` no resolvió a
 * tiempo. Node no cancela promesas de verdad, así que sin `clearTimeout` acá el timer sigue vivo
 * aunque `promise` gane la carrera — y dispara igual al vencer el plazo original, logueando un
 * "timeout" fantasma para una entidad cuyo research ya terminó rápido y bien.
 *
 * Encontrado en vivo el 2026-09-03 revisando una corrida real: las 6 entidades mostraban
 * `research_competencia_social_timeout` en el log, pero los timestamps no cuadraban con un cuelgue
 * real — el `.finally()` que faltaba acá es la causa. Compartido entre el bloque social y el de ads
 * (research-competencia-ads.ts) para no repetir el mismo bug al sumar el segundo timeout.
 */
function raceWithLoggedTimeout<T>(promise: Promise<T | null>, ms: number, msg: string, entityId: string): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        console.log(JSON.stringify({ ts: Date.now(), msg, entityId, timeoutMs: ms }));
        resolve(null);
      }, ms);
    }),
  ]);
}

// Guard en proceso contra corridas superpuestas dentro del MISMO proceso de Node — dos llamadas
// a runResearchCompetencia() en el mismo proceso escribirían sobre las mismas páginas de estado
// de Notion. Este módulo corre hoy SOLO dentro del script standalone `research:now`
// (`scripts/research-competencia-now.ts`, invocado por un cron externo de launchd) — ya no vive
// dentro del daemon de Jano. El flag no cubre exclusión cross-proceso (dos corridas del script en
// paralelo); si algún día hace falta eso, upgrade a un lock real (archivo/KV), no este flag.
let researchInFlight = false;

// Chequeo SÍNCRONO para que un caller externo pueda mirar el estado ANTES de arrancar, en vez de
// enterarse recién en el `.catch()` de la promesa rechazada. `runResearchCompetencia` sigue
// siendo la fuente de verdad (esto es una LECTURA del mismo flag, no reemplaza el guard).
export function isResearchCompetenciaInFlight(): boolean {
  return researchInFlight;
}

export async function runResearchCompetencia(opts: RunOpts = {}): Promise<RunResult> {
  if (researchInFlight) {
    throw new Error("Ya hay un research de competencia en curso — esperá a que termine antes de arrancar otro.");
  }
  researchInFlight = true;
  // Sesión de Chrome ÚNICA para toda la corrida (research-competencia-browser.ts) — se abre acá,
  // ANTES del loop de entidades, y se pasa a cada `fetchSocialText`; se cierra en el `finally` de
  // abajo sin importar cómo termine la corrida. Si falla abrir Chrome (binario no instalado,
  // puerto CDP que nunca respondió), el research SIGUE igual con Fase 1 + ads — solo el bloque
  // social queda sin datos esta corrida (mismo criterio de resiliencia que cualquier otra fuente
  // opcional acá: un componente roto no tumba a los demás).
  let browserSession: ResearchBrowserSession | null = null;
  try {
    const timeframeDias = opts.timeframeDias ?? 7;
    const targetIds = opts.entidadIds?.length ? opts.entidadIds : ENTITIES.map((e) => e.id);
    const fecha = nowInLaPaz().slice(0, 10);

    try {
      browserSession = await openResearchBrowserSession();
    } catch (err) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_browser_open_failed", err: String(err) }));
    }

    const resultados: EntityRunResult[] = [];
    // Cada entidad dispara un agente SDK one-off (maxTurns:20, WebSearch) — en una prueba real
    // gastó ~6 WebSearch + 2 WebFetch; con 6 entidades son ~48+ tool calls por corrida SOLO del
    // agente. Desde que se cableó el scraping social (research-competencia-social.ts), ese ya no
    // es el costo dominante: por entidad puede escalar a varios handles × hasta
    // MAX_POSTS_PER_ACCOUNT posts × hasta MAX_VIDEOS_PER_ACCOUNT videos con descarga+ffmpeg+visión
    // cada uno, órdenes de magnitud por encima del costo del agente — ver el comentario de
    // `enrichPosts` para el detalle del peor caso.
    for (const entityId of targetIds) {
      let entity;
      try {
        entity = getEntity(entityId);
      } catch (err) {
        resultados.push({
          entityId,
          entityNombre: entityId,
          primeraCorrida: false,
          hallazgos: [],
          snapshot: { entityId, updatedAt: new Date().toISOString() },
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      try {
        const baseline = await readEntityState(entity.id);
        const socialTextPromise = browserSession
          ? fetchSocialText(entity, timeframeDias, { context: browserSession.context }).catch((err) => {
              console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_social_error", entityId: entity.id, err: String(err) }));
              return null;
            })
          : Promise.resolve(null);
        const socialTextWithDeadline = raceWithLoggedTimeout(
          socialTextPromise, SOCIAL_TIMEOUT_MS, "research_competencia_social_timeout", entity.id,
        );
        const adsTextPromise = fetchAdsText(entity, timeframeDias).catch((err) => {
          console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_ads_error", entityId: entity.id, err: String(err) }));
          return null;
        });
        const adsTextWithDeadline = raceWithLoggedTimeout(
          adsTextPromise, ADS_TIMEOUT_MS, "research_competencia_ads_timeout", entity.id,
        );
        const [ios, android, siteText, socialText, adsText] = await Promise.all([
          entity.ios ? fetchIosAppInfo(entity.ios) : Promise.resolve(null),
          entity.android ? fetchAndroidAppInfo(entity.android.packageName) : Promise.resolve(null),
          entity.siteUrl ? fetchSiteText(entity.siteUrl) : Promise.resolve(null),
          socialTextWithDeadline,
          adsTextWithDeadline,
        ]);
        const facts: MechanicalFacts = {
          ios: ios ? { version: ios.version, rating: ios.rating, releaseNotes: ios.releaseNotes } : null,
          android: android ? { version: android.version, rating: android.rating, releaseNotes: android.releaseNotes } : null,
          siteText,
          socialText,
          adsText,
        };
        const prompt = buildEntityPrompt(entity, baseline, facts, timeframeDias);
        // BLOQUEANTE 2 (revisión de salud, 2026-09-03): deadline externo contra `AGENT_TIMEOUT_MS`
        // (ver su comentario) — sin esto, un `runEntityAgent` colgado (evento final que nunca
        // llega) trababa el proceso entero para siempre. El rechazo de este `Promise.race` cae en
        // el `catch` de la entidad más abajo, mismo tratamiento que cualquier otro error.
        const raw = await Promise.race([
          runEntityAgent(prompt),
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new Error(`El agente no respondió en ${AGENT_TIMEOUT_MS / 1000}s (timeout — posible cuelgue de WebSearch o del SDK)`));
            }, AGENT_TIMEOUT_MS);
          }),
        ]);
        // raw vacío = el agente cortó por maxTurns sin emitir result/success (nunca tiró
        // excepción) — tratarlo como "sin hallazgos" lo confundiría con una semana sin
        // novedades. Error explícito, para que se vea en "⚠️ Falló" en vez de perderse.
        if (!raw.trim()) throw new Error("El agente no devolvió resultado (posible corte por maxTurns)");
        const parsed = parseAgentJson(raw);

        const snapshot = {
          entityId: entity.id,
          updatedAt: new Date().toISOString(),
          ios: ios
            ? { trackId: entity.ios?.trackId, version: ios.version, rating: ios.rating ?? undefined, ratingCount: ios.ratingCount ?? undefined }
            : undefined,
          android: android
            ? { version: android.version ?? undefined, rating: android.rating ?? undefined, ratingCount: android.ratingCount ?? undefined }
            : undefined,
          siteSnippet: siteText?.slice(0, 3000),
          notas: parsed.notas,
          battlecard: parsed.battlecard,
        };

        resultados.push({
          entityId: entity.id,
          entityNombre: entity.nombre,
          primeraCorrida: baseline === null,
          hallazgos: parsed.hallazgos,
          snapshot,
        });
      } catch (err) {
        resultados.push({
          entityId: entity.id,
          entityNombre: entity.nombre,
          primeraCorrida: false,
          hallazgos: [],
          snapshot: { entityId: entity.id, updatedAt: new Date().toISOString() },
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const { pageId: informePageId, url: informeUrl } = await createInformePage(fecha, timeframeDias, resultados);

    // BLOQUEANTE 1 (revisión de salud, 2026-09-03): try/catch POR ENTIDAD, mismo patrón que el
    // loop principal de arriba — era el único paso del pipeline sin aislamiento. Sin esto, un solo
    // fallo de Notion (rate limit, blip de red, un PATCH que excede un límite) en, por ejemplo, la
    // entidad 3 de 6 rechazaba la promesa de runResearchCompetencia() sin catch intermedio: el
    // script caía al main().catch() genérico (console.error + exit(1)), Cal no recibía NI el
    // resumen NI un aviso de error, y las entidades 4-6 — cuyo research ya había corrido bien y
    // estaba en memoria — nunca se escribían, perdiendo su battlecard y su baseline de esa semana
    // en silencio. Marcar `r.error` acá (aunque la entidad ya hubiera generado hallazgos con
    // éxito) hace que `formatSummaryHtml` la liste bajo "⚠️ Falló" — Cal se entera de que ESE
    // research se perdió, no que fue una semana tranquila.
    for (const r of resultados) {
      if (r.error) continue;
      try {
        if (!r.primeraCorrida && r.hallazgos.length > 0) await appendCambios(r.entityId, r.hallazgos, informePageId, fecha);
        await writeEntityState(r.entityId, r.snapshot, chunkText);
      } catch (err) {
        console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_notion_write_error", entityId: r.entityId, err: String(err) }));
        r.error = err instanceof Error ? err.message : String(err);
      }
    }

    const totalHallazgos = resultados.reduce((sum, r) => sum + r.hallazgos.length, 0);
    return { fecha, timeframeDias, entidades: resultados, totalHallazgos, informeUrl, socialBrowserAvailable: browserSession !== null };
  } finally {
    await browserSession?.close().catch(() => {});
    researchInFlight = false;
  }
}

export function formatSummaryHtml(result: RunResult): string {
  const lines = [`🔎 <b>Research de competencia</b> — ${result.fecha} (últimos ${result.timeframeDias} días)`];
  // Bloqueante 2 (revisión de salud), adaptado al diseño de Chrome real: si el browser no pudo
  // abrirse, el research corre igual y emite "sin novedades" — texto idéntico al de una semana
  // tranquila real. Bajo un cron desatendido, el resumen de Telegram es el ÚNICO canal (el log
  // `research_competencia_browser_open_failed` va a stdout, que nadie mira bajo launchd), así que
  // la advertencia tiene que vivir acá, no solo en el log estructurado.
  if (!result.socialBrowserAvailable) {
    lines.push(
      "⚠️ No se pudo abrir Chrome para el scraping social esta corrida — Instagram/TikTok/Facebook/X quedaron sin datos. Los hallazgos de esta corrida NO reflejan RRSS. Revisar que Google Chrome esté instalado y el perfil dedicado (~/.cos-agent/research-competencia-chrome-profile).",
    );
  }
  if (result.totalHallazgos === 0) {
    lines.push("Sin novedades relevantes esta corrida.");
  } else {
    lines.push(`${result.totalHallazgos} hallazgo${result.totalHallazgos !== 1 ? "s" : ""}:`);
    for (const e of result.entidades) {
      if (e.hallazgos.length > 0) lines.push(`• <b>${e.entityNombre}</b> — ${e.hallazgos.length}`);
    }
  }
  const primeraCorrida = result.entidades.filter((e) => e.primeraCorrida);
  if (primeraCorrida.length > 0) {
    lines.push(`🆕 ${primeraCorrida.length} primera corrida — sin comparación todavía: ${primeraCorrida.map((e) => e.entityNombre).join(", ")}`);
  }
  const errores = result.entidades.filter((e) => e.error);
  if (errores.length > 0) lines.push(`⚠️ Falló: ${errores.map((e) => e.entityNombre).join(", ")}`);
  if (result.informeUrl) lines.push(`\n📄 Informe completo: ${result.informeUrl}`);
  return lines.join("\n");
}
