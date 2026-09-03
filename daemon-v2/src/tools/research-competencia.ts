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

export async function runResearchCompetencia(opts: RunOpts = {}): Promise<RunResult> {
  const timeframeDias = opts.timeframeDias ?? 7;
  const targetIds = opts.entidadIds?.length ? opts.entidadIds : ENTITIES.map((e) => e.id);
  const fecha = nowInLaPaz().slice(0, 10);

  const resultados: EntityRunResult[] = [];
  // Cada entidad dispara un agente SDK one-off (maxTurns:12, WebSearch) — en una prueba real gastó
  // ~6 WebSearch + 2 WebFetch; con 6 entidades por corrida son ~48+ tool calls por corrida semanal.
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
      const [ios, android, siteText, socialText] = await Promise.all([
        entity.ios ? fetchIosAppInfo(entity.ios) : Promise.resolve(null),
        entity.android ? fetchAndroidAppInfo(entity.android.packageName) : Promise.resolve(null),
        entity.siteUrl ? fetchSiteText(entity.siteUrl) : Promise.resolve(null),
        // El scraping social no debe poder tumbar la entidad: si tira, se sigue con las demás
        // fuentes — logueado, para no perder el rastro en un cron desatendido.
        fetchSocialText(entity, timeframeDias, { getCookies: opts.getCookies }).catch((err) => {
          console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_social_error", entityId: entity.id, err: String(err) }));
          return null;
        }),
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
