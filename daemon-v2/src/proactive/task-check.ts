import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { sendMessage } from "@cos/shared";
import { nowInLaPaz } from "../journal-capture.js";
import {
  gmailAccessToken,
  searchTaskEmails,
  getGmailMessage,
  downloadGmailAttachmentBuffer,
  archiveAndMarkRead,
  type GmailCreds,
} from "./kpi-ingest-gmail.js";
import { extractTaskFields, type TaskExtractResult } from "./task-extract.js";
import {
  hasTareaTag,
  stripTareaTag,
  createTaskPage,
  appendTaskFollowup,
  notifyMissingDate,
  uploadAttachmentToNotion,
  type TaskAttachmentRef,
} from "./task-notion.js";
import { CAL_PERSON } from "./task-people.js";
import { renderProposal } from "./task-card.js";
import type { TaskStore } from "./task-store.js";
import type { TaskProposal, TaskQueueItem } from "./task-types.js";

const ERROR_DEDUP_MS = 2 * 60 * 60 * 1000;
const MAX_PROCESSED = 200;
const MAX_THREAD_PAGES = 300;
/** Tope de la cola. Un backlog más grande que esto es un problema distinto (Cal reenviando en
 * masa), y sin tope el archivo de estado crecería sin control. */
const MAX_QUEUE = 50;
/** Tope de avisos de "no pude preparar" por corrida — ver promoteNextUnsafe. */
const MAX_AVISOS_FALLA = 3;

const TASK_FROM = "clepesqueur@bcp.com.bo";
const TASK_TO = "carlos@lepesqueur.net";

export interface TaskCheckState {
  processed: string[];
  /** threadId → pageId de la tarea YA CREADA — un mail nuevo de ese hilo se agrega como
   * seguimiento, nunca vuelve a proponer una tarea. */
  threadPages: Record<string, string>;
  /**
   * Mails detectados esperando su turno. Guardan solo lo mínimo: el cuerpo, los adjuntos y la
   * síntesis con Sonnet se resuelven cuando el ítem llega al frente — así un tick con 5 mails no
   * dispara 5 llamadas al modelo de golpe ni deja correos escritos en disco.
   */
  queue: TaskQueueItem[];
  /** Propuesta mostrada en el chat ahora mismo. Mientras exista, el cron NO propone nada más:
   * una tarjeta activa por vez (decisión de Cal, 2026-07-28). */
  active: { proposalId: string; item: TaskQueueItem } | null;
  /** Ya se avisó que la cola está llena — para no repetir el aviso cada 15 min. */
  queueFullNotified?: boolean;
  lastErrorNotified: Record<string, number>;
}

export function defaultTaskCheckStatePath(): string {
  return `${process.env.HOME}/.cos-agent/task-check-state.json`;
}

export function readTaskCheckState(path: string): TaskCheckState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TaskCheckState>;
    return {
      processed: parsed.processed ?? [],
      threadPages: parsed.threadPages ?? {},
      queue: parsed.queue ?? [],
      active: parsed.active ?? null,
      queueFullNotified: parsed.queueFullNotified ?? false,
      lastErrorNotified: parsed.lastErrorNotified ?? {},
    };
  } catch {
    return { processed: [], threadPages: {}, queue: [], active: null, lastErrorNotified: {} };
  }
}

export function writeTaskCheckState(path: string, state: TaskCheckState): void {
  try {
    // Escritura atómica (temporal + rename), igual que el writer de backlogs. Antes era un
    // writeFileSync directo: como readTaskCheckState traga cualquier error devolviendo estado
    // vacío, un archivo cortado a la mitad ahora se llevaría puestos `queue` y `threadPages`
    // (o sea, mails encolados y el mapa de hilos ya convertidos), no solo la lista de processed.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, path);
  } catch {
    /* noop */
  }
}

/**
 * Muta el estado leyéndolo y escribiéndolo SIN awaits en el medio.
 *
 * El cron y los callbacks de la tarjeta corren en el mismo proceso pero intercalados por el event
 * loop: si una función leyera el estado, esperara a Notion y recién después escribiera, pisaría
 * lo que el otro camino guardó mientras tanto (ej. el cron encolando un mail nuevo mientras Cal
 * confirma una tarea). Toda escritura de estado pasa por acá.
 */
function mutateState(path: string, fn: (s: TaskCheckState) => void): TaskCheckState {
  const state = readTaskCheckState(path);
  fn(state);
  writeTaskCheckState(path, state);
  return state;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// nunca toISOString() directo acá: eso da la fecha en UTC, y La Paz es UTC-4 — un mail recibido
// entre las 20:00 y medianoche hora local quedaría fechado al día siguiente. nowInLaPaz() ya
// resuelve el offset fijo -04:00 (ver journal-capture.ts).
function isoDateFromMillis(ms: number): string {
  return nowInLaPaz(new Date(ms)).slice(0, 10);
}

export interface CheckTaskEmailsOpts {
  botToken: string;
  chatId: number;
  notionToken: string;
  gmail: GmailCreds;
  store: TaskStore;
  /** Override para tests — default: `~/.cos-agent/task-check-state.json`. */
  statePath?: string;
}

function statePathOf(opts: CheckTaskEmailsOpts): string {
  return opts.statePath ?? defaultTaskCheckStatePath();
}

/** Cuántos mails esperan detrás del que está en pantalla. */
export function pendingTaskCount(opts: CheckTaskEmailsOpts): number {
  return readTaskCheckState(statePathOf(opts)).queue.length;
}

let running = false;

/**
 * Mails que Cal reenvía a mano con "(Tarea)" en el subject → PROPUESTA de tarea en el chat, y
 * recién al confirmarla nace la página en Notion (decisión de Cal, 2026-07-28).
 *
 * Los mails detectados se encolan y se proponen de a uno: una tarjeta activa por vez. El mail se
 * marca processed al ENCOLAR (para no re-encolarlo cada 15 min) pero NO se archiva hasta que la
 * tarea se crea — la inbox queda como respaldo si Cal nunca toca la tarjeta.
 */
export async function checkTaskEmails(opts: CheckTaskEmailsOpts): Promise<void> {
  if (running) {
    console.error(JSON.stringify({ ts: Date.now(), msg: "task_check_overlap_skipped" }));
    return;
  }
  running = true;
  try {
    const statePath = statePathOf(opts);

    let messageIds: string[];
    let token: string;
    try {
      token = await gmailAccessToken(opts.gmail);
      const found = await searchTaskEmails(token);
      messageIds = found.map((m) => m.id);
    } catch (err) {
      console.error(JSON.stringify({ ts: Date.now(), msg: "task_check_search_error", err: String(err) }));
      return;
    }

    for (const id of messageIds) {
      if (readTaskCheckState(statePath).processed.includes(id)) continue;
      await intakeMessage(id, token, opts);
    }

    await ensureActiveProposal(opts);
    trimState(statePath);
  } finally {
    running = false;
  }
}

function trimState(statePath: string): void {
  mutateState(statePath, (s) => {
    if (s.processed.length > MAX_PROCESSED) s.processed = s.processed.slice(-MAX_PROCESSED);
    const entries = Object.entries(s.threadPages);
    if (entries.length > MAX_THREAD_PAGES) s.threadPages = Object.fromEntries(entries.slice(-MAX_THREAD_PAGES));
  });
}

/** Clasifica un mail nuevo: seguimiento de una tarea ya creada, seguimiento de algo que todavía
 * está en cola, o ítem nuevo. Nunca crea nada en Notion salvo el bloque de seguimiento. */
async function intakeMessage(id: string, token: string, opts: CheckTaskEmailsOpts): Promise<void> {
  const statePath = statePathOf(opts);
  try {
    const detail = await getGmailMessage(id, token);

    const subject = detail.subject ?? "";
    if (!hasTareaTag(subject)) {
      // Igual gotcha que daily-note-check.ts: un false positive de la búsqueda de Gmail es
      // determinista (no va a cambiar en el próximo tick) — se marca processed sin reintentar
      // ni notificar, para no espamear a Cal cada 15 min.
      console.error(JSON.stringify({ ts: Date.now(), msg: "task_tag_mismatch_skipped", id, subject }));
      mutateState(statePath, (s) => markProcessed(s, id));
      return;
    }

    const threadId = detail.threadId;
    if (!threadId) throw new Error("el mensaje de Gmail no trae threadId");

    const state = readTaskCheckState(statePath);

    // (a) El hilo ya tiene tarea creada → seguimiento en la página existente, como siempre.
    const existingPageId = state.threadPages[threadId];
    if (existingPageId) {
      const bodyText = (detail.bodyText ?? "").trim();
      const fechaRecepcion = isoDateFromMillis(detail.internalDate);
      const extract = bodyText ? await extractTaskFields(subject, fechaRecepcion, bodyText) : null;
      await appendTaskFollowup(opts.notionToken, existingPageId, {
        fechaRecepcion,
        resumen: extract?.resumen ?? bodyText.slice(0, 600) ?? "(sin cuerpo legible)",
      });
      await sendReport(
        opts.botToken,
        opts.chatId,
        `💬 <b>Nueva info en un hilo ya convertido en tarea</b>\n📋 ${escapeHtml(stripTareaTag(subject))}`,
      );
      mutateState(statePath, (s) => markProcessed(s, id));
      return;
    }

    // (b) El hilo ya está propuesto o en cola → se anexa ahí, no nace una segunda propuesta.
    const enCola =
      state.active?.item.threadId === threadId ||
      state.queue.some((q) => q.threadId === threadId);
    if (enCola) {
      mutateState(statePath, (s) => {
        if (s.active?.item.threadId === threadId) s.active.item.followupIds.push(id);
        else {
          const q = s.queue.find((x) => x.threadId === threadId);
          if (q) q.followupIds.push(id);
        }
        markProcessed(s, id);
      });
      // El followup también tiene que llegar al payload vivo en KV, no solo al estado en disco:
      // la tarjeta lo muestra y createTaskFromProposal lo lee de ahí.
      const active = readTaskCheckState(statePath).active;
      if (active?.item.threadId === threadId) {
        const p = await opts.store.getProposal(opts.chatId, active.proposalId);
        if (p && !p.followupIds.includes(id)) {
          await opts.store.updateProposal(opts.chatId, active.proposalId, {
            ...p,
            followupIds: [...p.followupIds, id],
          });
        }
      }
      console.log(JSON.stringify({ ts: Date.now(), msg: "task_followup_queued", id, threadId }));
      return;
    }

    // (c) Ítem nuevo → a la cola.
    let colaLlena = false;
    mutateState(statePath, (s) => {
      if (s.queue.length >= MAX_QUEUE) {
        console.error(JSON.stringify({ ts: Date.now(), msg: "task_queue_full", id }));
        colaLlena = !s.queueFullNotified;
        s.queueFullNotified = true;
        return; // sin markProcessed: se reintenta cuando baje la cola
      }
      s.queueFullNotified = false;
      s.queue.push({ messageId: id, threadId, subject, followupIds: [] });
      markProcessed(s, id);
    });
    if (colaLlena) {
      // La búsqueda de Gmail solo mira los últimos 3 días: si la cola sigue llena al cuarto, el
      // mail sale de la ventana y no vuelve nunca. Sin este aviso, el abandono es silencioso
      // (mismo gap ya documentado para el pipeline de Lending).
      await sendReport(
        opts.botToken,
        opts.chatId,
        `⚠️ <b>Cola de tareas llena</b> (${MAX_QUEUE})\nHay correos esperando que no puedo encolar. Resuelve las tarjetas pendientes: los que no entren en 3 días se pierden de la búsqueda.`,
      );
    }
    console.log(JSON.stringify({ ts: Date.now(), msg: "task_queued", id, threadId, subject }));
  } catch (err) {
    await notifyError(id, err, opts);
  }
}

/**
 * Garantiza que haya exactamente una propuesta viva. Si la activa venció por TTL en KV (7 días
 * sin que Cal la toque), se descarta y se propone la siguiente — así la cola nunca queda trabada.
 */
export function ensureActiveProposal(opts: CheckTaskEmailsOpts): Promise<void> {
  const statePath = statePathOf(opts);
  // La liberación del turno va DENTRO de la cadena junto con la promoción: si se limpiara
  // `active` fuera, un callback que esté promoviendo en paralelo terminaría con su propia
  // tarjeta recién mandada pisada por este `active = null`.
  return serializePromote(async () => {
    const state = readTaskCheckState(statePath);
    if (state.active) {
      const vive = await opts.store.getProposal(opts.chatId, state.active.proposalId);
      if (vive) return;
      console.log(JSON.stringify({ ts: Date.now(), msg: "task_proposal_expired", proposalId: state.active.proposalId }));
      mutateState(statePath, (s) => {
        s.active = null;
      });
    }
    await promoteNextUnsafe(opts);
  });
}

/**
 * Manda la tarjeta y, SOLO si el envío salió bien, marca el ítem como activo.
 *
 * ⚠️ El orden importa. Al revés (activo primero, envío después), un fallo del envío — un blip de
 * red o el SNI filtering que documenta CLAUDE.md — dejaba `active` apuntando a una propuesta cuya
 * tarjeta nunca llegó al chat: el cron la veía viva por 7 días (TTL del KV), no proponía nada más,
 * y todos los mails siguientes se acumulaban en la cola sin ningún aviso. Encontrado por
 * daemon-health-reviewer antes de producción.
 */
async function proposeCard(
  opts: CheckTaskEmailsOpts,
  item: TaskQueueItem,
  proposal: TaskProposal,
  proposalId: string,
): Promise<void> {
  const statePath = statePathOf(opts);
  const pendientes = Math.max(0, readTaskCheckState(statePath).queue.length - 1);
  const card = renderProposal(proposal, { pendientes, proposalId });

  try {
    await sendMessage(opts.botToken, {
      chatId: opts.chatId,
      text: card.text,
      parseMode: "HTML",
      replyMarkup: card.keyboard,
    });
  } catch (err) {
    // El ítem queda en la cola (con su propuesta ya sintetizada anotada) y se reintenta en el
    // próximo tick. Se corta acá, sin seguir con el resto de la cola: si Telegram no responde,
    // insistir con los demás solo multiplica el fallo.
    console.error(
      JSON.stringify({ ts: Date.now(), msg: "task_propose_send_failed", messageId: item.messageId, err: String(err) }),
    );
    return;
  }

  mutateState(statePath, (s) => {
    s.queue = s.queue.filter((q) => q.messageId !== item.messageId);
    s.active = { proposalId, item: { ...item, proposalId } };
  });
  console.log(
    JSON.stringify({ ts: Date.now(), msg: "task_proposed", proposalId, messageId: item.messageId, pendientes }),
  );
}

/**
 * Serializa TODA promoción de la cola.
 *
 * El flag `running` de checkTaskEmails solo lo protege de sí mismo: `advanceTaskQueue` y
 * `postponeActiveTask` entran a promoteNext desde los callbacks de la tarjeta, en paralelo con un
 * tick del cron. Y promoteNext lee `queue[0]`, espera segundos (Gmail + Sonnet) y recién después
 * escribe `active` — ventana de sobra para que los dos caminos promuevan el MISMO mail y manden
 * dos tarjetas confirmables del mismo correo. Encadenar es suficiente: el daemon es un solo
 * proceso. Encontrado por daemon-health-reviewer antes de producción.
 */
let promoteChain: Promise<void> = Promise.resolve();

/**
 * Techo de una promoción. Serializar convierte a la cadena en un cuello de botella global: si un
 * await de adentro queda colgado para siempre (subprocess del SDK wedgeado, una conexión TCP a
 * Telegram que nunca cierra — el daemon corre semanas), sin esto se encolarían detrás TODOS los
 * avances posteriores y cada botón ✅/❌/⏭️ quedaría esperando su `advanceQueue`. El timeout
 * destraba la cadena; el trabajo colgado se abandona (su estado ya está en disco o no llegó a
 * escribirse, y el ítem sigue en la cola para el próximo tick).
 */
const PROMOTE_TIMEOUT_MS = 120_000;

function serializePromote(fn: () => Promise<void>): Promise<void> {
  const conTecho = async () => {
    // El timer se limpia SIEMPRE al resolverse la carrera. Sin el clearTimeout, `Promise.race`
    // resuelve apenas termina fn() pero deja el timeout corriendo: 120 s después loguea
    // task_promote_timeout igual, aunque la promoción haya durado milisegundos. Con el cron cada
    // 15 min eso era un falso positivo por tick, y el ruido tapaba justo lo que el techo existe
    // para detectar — una cadena colgada de verdad.
    let handle: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        fn(),
        new Promise<void>((resolve) => {
          handle = setTimeout(() => {
            console.error(JSON.stringify({ ts: Date.now(), msg: "task_promote_timeout", ms: PROMOTE_TIMEOUT_MS }));
            resolve();
          }, PROMOTE_TIMEOUT_MS);
          handle.unref();
        }),
      ]);
    } finally {
      if (handle) clearTimeout(handle);
    }
  };
  promoteChain = promoteChain.then(conTecho, conTecho);
  return promoteChain;
}

/**
 * Saca el primero de la cola, lo sintetiza y manda su tarjeta. Mensaje NUEVO a propósito: es lo
 * que genera el push en el teléfono de Cal (un edit no notifica).
 *
 * ⚠️ Nunca llamar esto fuera de un `serializePromote` — y nunca envolverlo en OTRO
 * `serializePromote` desde adentro de la cadena: encolarse detrás de uno mismo es un deadlock.
 */
async function promoteNextUnsafe(opts: CheckTaskEmailsOpts): Promise<void> {
  const statePath = statePathOf(opts);
  let avisosDeFalla = 0;

  while (true) {
    const state = readTaskCheckState(statePath);
    if (state.active || state.queue.length === 0) return;

    const item = state.queue[0]!;
    try {
      // Un intento anterior ya sintetizó esta propuesta y solo falló al mandar la tarjeta: se
      // reusa tal cual. Sin esto, con Telegram caído el cron rehace Gmail + Sonnet sobre el mismo
      // correo cada 15 minutos.
      const cacheada = item.proposalId
        ? await opts.store.getProposal(opts.chatId, item.proposalId).catch(() => null)
        : null;
      if (cacheada && item.proposalId) {
        await proposeCard(opts, item, cacheada, item.proposalId);
        return;
      }

      const token = await gmailAccessToken(opts.gmail);
      const detail = await getGmailMessage(item.messageId, token);
      const bodyText = (detail.bodyText ?? "").trim();
      if (!bodyText) throw new Error("el mail no tiene cuerpo de texto legible (ni text/plain ni text/html)");

      const fechaRecepcion = isoDateFromMillis(detail.internalDate);
      const extract: TaskExtractResult = (await extractTaskFields(item.subject, fechaRecepcion, bodyText)) ?? {
        resumen: bodyText.slice(0, 280),
        accionRequerida: "Revisar manualmente — no se pudo sintetizar automáticamente el pedido.",
        contextoRelevante: null,
        deadline: null,
        fecha: null,
        sinAccionClara: true,
      };

      const proposal: TaskProposal = {
        messageId: item.messageId,
        threadId: item.threadId,
        subject: item.subject,
        title: stripTareaTag(item.subject) || `Tarea sin asunto (${item.messageId})`,
        from: TASK_FROM,
        to: TASK_TO,
        fechaRecepcion,
        resumen: extract.resumen,
        accionRequerida: extract.accionRequerida,
        contextoRelevante: extract.contextoRelevante,
        sinAccionClara: extract.sinAccionClara,
        asignadoId: CAL_PERSON.id,
        asignadoNombre: CAL_PERSON.nombre,
        fecha: extract.fecha,
        deadline: extract.deadline,
        attachments: detail.attachments.map((a) => ({
          filename: a.filename,
          mimeType: a.mimeType,
          attachmentId: a.attachmentId,
        })),
        followupIds: item.followupIds,
      };

      const proposalId = await opts.store.createProposal(opts.chatId, proposal);
      // Se anota en la cola ANTES de intentar el envío: si el envío falla, el próximo tick
      // encuentra la propuesta ya hecha y no vuelve a pagar Gmail + Sonnet.
      mutateState(statePath, (s) => {
        const q = s.queue.find((x) => x.messageId === item.messageId);
        if (q) q.proposalId = proposalId;
      });

      await proposeCard(opts, item, proposal, proposalId);
      return;
    } catch (err) {
      // El mail se borró de Gmail, perdió el cuerpo o falló la síntesis: se saca de la cola con
      // aviso y se sigue con el siguiente — un ítem roto no puede bloquear a los demás.
      console.error(
        JSON.stringify({ ts: Date.now(), msg: "task_promote_failed", messageId: item.messageId, err: String(err) }),
      );
      mutateState(statePath, (s) => {
        s.queue = s.queue.filter((q) => q.messageId !== item.messageId);
      });
      // Tope de avisos por corrida: si la cola tiene 20 mails rotos, 20 mensajes seguidos son
      // spam puro. Los demás quedan en el log (task_promote_failed), que es donde se diagnostica.
      if (avisosDeFalla < MAX_AVISOS_FALLA) {
        avisosDeFalla++;
        await sendReport(
          opts.botToken,
          opts.chatId,
          `⚠️ <b>No pude preparar una tarea del correo</b>\n📋 ${escapeHtml(stripTareaTag(item.subject))}\n${escapeHtml(String(err).slice(0, 200))}`,
        );
      }
      // sigue el while con el próximo ítem
    }
  }
}

/**
 * Tras crear o descartar: libera el turno y propone el siguiente.
 *
 * `proposalId` identifica QUÉ propuesta se está cerrando: se libera el turno solo si sigue siendo
 * la activa. Sin esa condición hay una carrera real — el handler borra la propuesta de KV y recién
 * después de un round-trip a Telegram (el edit de la tarjeta) llama acá; si un tick del cron cae
 * en el medio, `ensureActiveProposal` la ve muerta, promueve la siguiente y manda su tarjeta, y
 * este `active = null` incondicional la pisaba y promovía OTRA. Quedaban dos tarjetas vivas.
 */
export function advanceTaskQueue(opts: CheckTaskEmailsOpts, proposalId?: string): Promise<void> {
  return serializePromote(async () => {
    const statePath = statePathOf(opts);
    const active = readTaskCheckState(statePath).active;
    if (proposalId && active && active.proposalId !== proposalId) {
      // Otro camino ya avanzó y hay una propuesta más nueva en pantalla: no tocarla.
      console.log(JSON.stringify({ ts: Date.now(), msg: "task_advance_skipped_stale", proposalId, activo: active.proposalId }));
      return;
    }
    mutateState(statePath, (s) => {
      s.active = null;
    });
    await promoteNextUnsafe(opts);
  });
}

/** "⏭️ Después": la propuesta activa vuelve al FINAL de la cola (conserva sus followups) y se
 * propone la siguiente. La propuesta en KV se descarta: cuando le toque el turno otra vez se
 * vuelve a sintetizar, así refleja el mail tal como está en ese momento. */
export function postponeActiveTask(opts: CheckTaskEmailsOpts): Promise<void> {
  const statePath = statePathOf(opts);
  return serializePromote(async () => {
    const active = readTaskCheckState(statePath).active;
    if (!active) return;

    await opts.store.clearProposal(opts.chatId, active.proposalId).catch(() => {});
    mutateState(statePath, (s) => {
      s.active = null;
      // Sin `proposalId`: la propuesta se acaba de borrar de KV, y dejarlo apuntando a un id
      // muerto haría que el reintento lo busque al pedo. Cuando vuelva a tocarle turno se
      // re-sintetiza, que es justamente lo que se quiere de un "⏭️ Después".
      s.queue.push({ ...active.item, proposalId: undefined });
    });
    await promoteNextUnsafe(opts);
  });
}

/**
 * Crea la página en Notion desde una propuesta confirmada: sube los adjuntos, escribe la página,
 * apenda los correos de seguimiento, avisa si falta Fecha/Deadline y archiva el mail.
 *
 * Los adjuntos se bajan y suben ACÁ, no al proponer: los `file_upload` de Notion caducan en ~1h y
 * Cal puede tocar la tarjeta al día siguiente.
 */
export async function createTaskFromProposal(
  opts: CheckTaskEmailsOpts,
  p: TaskProposal,
  proposalId?: string,
): Promise<{ url: string; adjuntosSubidos: number; adjuntosTotal: number; yaExistia?: boolean }> {
  const statePath = statePathOf(opts);

  // Guard de idempotencia. Sin esto, un segundo intento sobre el mismo hilo — el "🔄 Reintentar"
  // tras un fallo parcial, o un doble tap después de que venza el lock de 60s mientras se suben
  // adjuntos — crea una SEGUNDA página en Notion. El hilo es la unidad: si ya tiene página, se
  // devuelve esa.
  const yaCreada = readTaskCheckState(statePath).threadPages[p.threadId];
  if (yaCreada) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "task_create_skipped_duplicate", threadId: p.threadId, pageId: yaCreada }));
    return {
      url: `https://www.notion.so/${yaCreada.replace(/-/g, "")}`,
      adjuntosSubidos: 0,
      adjuntosTotal: p.attachments.length,
      yaExistia: true,
    };
  }

  const token = await gmailAccessToken(opts.gmail);

  const attachments = await uploadAttachments(p.messageId, p.attachments, opts.notionToken, token);
  const preguntas = buildPreguntas(p);

  const result = await createTaskPage(opts.notionToken, {
    title: p.title,
    resumen: p.resumen,
    deadline: p.deadline,
    fecha: p.fecha,
    asignadoId: p.asignadoId,
    body: {
      from: p.from,
      to: p.to,
      subject: p.subject,
      fechaRecepcion: p.fechaRecepcion,
      resumen: p.resumen,
      accionRequerida: p.accionRequerida,
      contextoRelevante: p.contextoRelevante,
      threadId: p.threadId,
      sinAccionClara: p.sinAccionClara,
      preguntas,
      attachments,
    },
  });

  mutateState(statePath, (s) => {
    s.threadPages[p.threadId] = result.pageId;
  });

  // Correos posteriores del mismo hilo llegados mientras la propuesta esperaba. Van con el cuerpo
  // crudo recortado, sin pasar por el modelo: son la excepción, no el camino principal, y no
  // justifican una llamada por correo.
  //
  // Se relee la propuesta de KV: un mail del mismo hilo puede haber llegado DESPUÉS de que el
  // handler leyó `p` (el intake lo apenda al payload vivo), y con la copia vieja ese correo
  // quedaría processed, sin adjuntar y sin poder reabrir propuesta.
  let followupIds = p.followupIds;
  if (proposalId) {
    const fresh = await opts.store.getProposal(opts.chatId, proposalId).catch(() => null);
    if (fresh) followupIds = [...new Set([...followupIds, ...fresh.followupIds])];
  }

  for (const followupId of followupIds) {
    try {
      const detail = await getGmailMessage(followupId, token);
      await appendTaskFollowup(opts.notionToken, result.pageId, {
        fechaRecepcion: isoDateFromMillis(detail.internalDate),
        resumen: (detail.bodyText ?? "").trim().slice(0, 600) || "(sin cuerpo legible)",
      });
    } catch (err) {
      console.error(
        JSON.stringify({ ts: Date.now(), msg: "task_followup_append_failed", followupId, err: String(err) }),
      );
    }
  }

  if (preguntas.length > 0) {
    try {
      await notifyMissingDate(opts.notionToken, result.pageId, `falta Fecha/Deadline en la tarea "${p.title}".`);
    } catch (err) {
      console.error(JSON.stringify({ ts: Date.now(), msg: "task_notify_missing_date_failed", err: String(err) }));
    }
  }

  for (const id of [p.messageId, ...followupIds]) {
    try {
      await archiveAndMarkRead(id, token);
    } catch (err) {
      // Requiere scope gmail.modify — mismo gotcha documentado en kpi-ingest-check.ts (pendiente
      // que Cal regenere el token con ese scope). No rompe el resto del flujo.
      console.error(JSON.stringify({ ts: Date.now(), msg: "task_archive_failed", id, err: String(err) }));
    }
  }

  return { url: result.url, adjuntosSubidos: attachments.length, adjuntosTotal: p.attachments.length };
}

export function buildPreguntas(p: { fecha: string | null; deadline: string | null }): string[] {
  const preguntas: string[] = [];
  if (!p.fecha) preguntas.push("¿Cuándo debería trabajarse esta tarea (Fecha)?");
  if (!p.deadline) preguntas.push("¿Tiene un Deadline concreto esta tarea?");
  return preguntas;
}

async function uploadAttachments(
  messageId: string,
  attachments: Array<{ filename: string; mimeType: string; attachmentId: string }>,
  notionToken: string,
  accessToken: string,
): Promise<TaskAttachmentRef[]> {
  const refs: TaskAttachmentRef[] = [];
  for (const a of attachments) {
    try {
      const bytes = await downloadGmailAttachmentBuffer(messageId, a.attachmentId, accessToken);
      const fileUploadId = await uploadAttachmentToNotion(notionToken, { filename: a.filename, mimeType: a.mimeType, bytes });
      refs.push({ filename: a.filename, fileUploadId });
    } catch (err) {
      console.error(JSON.stringify({ ts: Date.now(), msg: "task_attachment_upload_failed", messageId, filename: a.filename, err: String(err) }));
    }
  }
  return refs;
}

function markProcessed(state: TaskCheckState, id: string): void {
  if (!state.processed.includes(id)) state.processed.push(id);
  delete state.lastErrorNotified[id];
}

async function notifyError(id: string, err: unknown, opts: CheckTaskEmailsOpts): Promise<void> {
  const statePath = statePathOf(opts);
  const now = Date.now();
  const last = readTaskCheckState(statePath).lastErrorNotified[id] ?? 0;
  if (now - last >= ERROR_DEDUP_MS) {
    await sendReport(
      opts.botToken,
      opts.chatId,
      `⚠️ <b>No pude leer el correo de tarea</b>\n${escapeHtml(String(err).slice(0, 200))}\nReintento automático en el próximo tick.`,
    );
    mutateState(statePath, (s) => {
      s.lastErrorNotified[id] = now;
    });
  }
  console.error(JSON.stringify({ ts: Date.now(), msg: "task_process_error", id, err: String(err) }));
}

async function sendReport(botToken: string, chatId: number, text: string): Promise<void> {
  try {
    await sendMessage(botToken, { chatId, text, parseMode: "HTML" });
  } catch (err) {
    console.error(JSON.stringify({ ts: Date.now(), msg: "task_report_send_failed", err: String(err) }));
  }
}
