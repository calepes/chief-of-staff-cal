import { getEntity, ENTITIES } from "./research-competencia-entities.js";
import { fetchIosAppInfo, fetchAndroidAppInfo, fetchSiteText, chunkText } from "./research-competencia-sources.js";
import { buildEntityPrompt, runEntityAgent, parseAgentJson, type MechanicalFacts } from "./research-competencia-agent.js";
import { fetchSocialText } from "./research-competencia-social.js";
import { readEntityState, writeEntityState, appendCambios, createInformePage } from "./research-competencia-notion.js";
import { nowInLaPaz } from "../journal-capture.js";
import type { EntityRunResult, RunResult } from "./research-competencia-types.js";
import type { StructuredCookie } from "./cookie-jar.js";

export interface RunOpts {
  timeframeDias?: number;
  entidadIds?: string[];
  /** Proveedor de cookies del Cookie Broker. Sin él, el scraping social corre sin sesión. */
  getCookies?: (hostname: string) => Promise<StructuredCookie[]>;
}

// Deadline duro del scraping social — carrera contra un timer, no un presupuesto chequeado entre
// iteraciones (eso no puede interrumpir un `await` colgado). `analyzePhoto` (vision.ts, fetch a
// OpenRouter) y `transcribeAudio` (whisper.ts, spawn de whisper-cli) NO tienen timeout propio —
// a diferencia de cada paso mecánico de la Fase 1 (page.goto 30s, ffmpeg 120s, descargas
// 30-120s), que sí. Un cuelgue de red en cualquiera de los dos dejaría la promesa sin resolver
// NI rechazar para siempre: el try/catch por entidad nunca dispara, la entidad traba el `for`
// secuencial de las 6, y con ella el informe de Notion y el mensaje de Telegram de la semana
// entera. 8 minutos porque una entidad con varios handles y videos puede tardar legítimamente
// varios minutos (enrichPosts documenta hasta "decenas de minutos" en el peor caso combinando
// descarga+ffmpeg+visión por post en research-competencia-social.ts) — tiene que cubrir ese caso
// real sin ser efectivamente infinito. Al vencer, la entidad sigue con socialText:null (logueado);
// el scraping abandonado sigue corriendo en background (Node no cancela promesas de verdad), pero
// nunca puede tirar sin capturar — va completo detrás de su propio `.catch()`.
const SOCIAL_TIMEOUT_MS = 8 * 60 * 1000;

// Guard en proceso contra corridas superpuestas — el cron semanal (checkResearchCompetenciaWeekly)
// y la tool `investigarCompetencia` viven en el MISMO daemon, así que un flag de módulo alcanza:
// las dos escriben sobre las mismas páginas de estado de Notion, y con el scraping social la
// corrida puede extenderse mucho más que en Fase 1 (minutos → potencialmente decenas de minutos),
// agrandando la ventana real de que Cal dispare una corrida on-demand mientras el cron sigue
// andando. NO cubre el script standalone `research:now` (`scripts/research-competencia-now.ts`) —
// corre en OTRO proceso de Node, sin este módulo cargado en memoria. Si algún día hace falta
// exclusión cross-proceso, upgrade a un lock real (archivo/KV), no este flag.
let researchInFlight = false;

// Chequeo SÍNCRONO para que un caller (la tool `investigarCompetencia`) pueda mirar el estado
// ANTES de arrancar, en vez de enterarse recién en el `.catch()` de la promesa rechazada — sin
// esto, la tool devolvía `status:"started"` (el LLM le decía a Cal "arrancó") y un instante
// después llegaba un ❌ contradictorio con el mensaje de este guard. `runResearchCompetencia`
// sigue siendo la fuente de verdad (esto es una LECTURA del mismo flag, no reemplaza el guard).
export function isResearchCompetenciaInFlight(): boolean {
  return researchInFlight;
}

export async function runResearchCompetencia(opts: RunOpts = {}): Promise<RunResult> {
  if (researchInFlight) {
    throw new Error("Ya hay un research de competencia en curso — esperá a que termine antes de arrancar otro.");
  }
  researchInFlight = true;
  try {
    const timeframeDias = opts.timeframeDias ?? 7;
    const targetIds = opts.entidadIds?.length ? opts.entidadIds : ENTITIES.map((e) => e.id);
    const fecha = nowInLaPaz().slice(0, 10);

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
        const socialTextPromise = fetchSocialText(entity, timeframeDias, { getCookies: opts.getCookies }).catch((err) => {
          console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_social_error", entityId: entity.id, err: String(err) }));
          return null;
        });
        const socialTextWithDeadline = Promise.race([
          socialTextPromise,
          new Promise<null>((resolve) => {
            setTimeout(() => {
              console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_social_timeout", entityId: entity.id, timeoutMs: SOCIAL_TIMEOUT_MS }));
              resolve(null);
            }, SOCIAL_TIMEOUT_MS);
          }),
        ]);
        const [ios, android, siteText, socialText] = await Promise.all([
          entity.ios ? fetchIosAppInfo(entity.ios) : Promise.resolve(null),
          entity.android ? fetchAndroidAppInfo(entity.android.packageName) : Promise.resolve(null),
          entity.siteUrl ? fetchSiteText(entity.siteUrl) : Promise.resolve(null),
          socialTextWithDeadline,
        ]);
        const facts: MechanicalFacts = {
          ios: ios ? { version: ios.version, rating: ios.rating, releaseNotes: ios.releaseNotes } : null,
          android: android ? { version: android.version, rating: android.rating, releaseNotes: android.releaseNotes } : null,
          siteText,
          socialText,
        };
        const prompt = buildEntityPrompt(entity, baseline, facts, timeframeDias);
        const raw = await runEntityAgent(prompt);
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

    for (const r of resultados) {
      if (r.error) continue;
      if (!r.primeraCorrida && r.hallazgos.length > 0) await appendCambios(r.entityId, r.hallazgos, informePageId, fecha);
      await writeEntityState(r.entityId, r.snapshot, chunkText);
    }

    const totalHallazgos = resultados.reduce((sum, r) => sum + r.hallazgos.length, 0);
    return { fecha, timeframeDias, entidades: resultados, totalHallazgos, informeUrl };
  } finally {
    researchInFlight = false;
  }
}

export function formatSummaryHtml(result: RunResult): string {
  const lines = [`🔎 <b>Research de competencia</b> — ${result.fecha} (últimos ${result.timeframeDias} días)`];
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
