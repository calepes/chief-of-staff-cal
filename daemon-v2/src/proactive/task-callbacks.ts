// task-callbacks.ts — handlers de los callbacks tsk:* de la tarjeta de propuesta de tarea.
// Son HEAVY: "✅ Crear tarea" escribe en Notion (página + adjuntos) y archiva el mail. El caller
// (index.ts) ya hizo answerCallbackQuery y tomó el lock anti-doble-tap, mismo patrón que
// journal-callbacks.ts / learning-callbacks.ts.
//
// Todo lo que toca disco (la cola) o red (Notion, Gmail) entra por `deps` — así el test corre
// el flujo completo sin tocar nada real.

import {
  personByIndex,
  renderAskInput,
  renderCreated,
  renderCreating,
  renderCreateFailed,
  type CreatedInfo,
  renderDatePicker,
  renderDiscarded,
  renderExpired,
  renderPeoplePicker,
  renderPersonNotFound,
  renderPostponed,
  renderProposal,
  type Card,
} from "./task-card.js";
import { resolveShortcut, type DateShortcut } from "./task-dates.js";
import { findPersonInNotion, findPersonInSnapshot, normalizeName } from "./task-people.js";
import { parseWrittenDate } from "./task-dates.js";
import type { TaskStore } from "./task-store.js";
import type { TaskPendingInput, TaskProposal } from "./task-types.js";

export function isTaskCallback(data: string | undefined): boolean {
  return typeof data === "string" && data.startsWith("tsk:");
}

export interface ParsedTaskCallback {
  action: string;
  proposalId: string;
  arg?: string;
}

export function parseTaskCallback(data: string): ParsedTaskCallback | null {
  const parts = data.split(":");
  if (parts[0] !== "tsk" || !parts[1] || !parts[2]) return null;
  return { action: parts[1], proposalId: parts[2], arg: parts[3] };
}

export interface TaskCallbackDeps {
  store: TaskStore;
  notionToken: string;
  /** Hoy en La Paz (yyyy-mm-dd). Inyectado para que los tests no dependan del reloj. */
  today: () => string;
  log: (obj: Record<string, unknown>) => void;
  /** Edita la tarjeta ancla. Manda SIEMPRE el keyboard completo (nunca lo omite — editMessageText
   * conserva el teclado viejo si se omite; gotcha de Telegram documentado en CLAUDE.md). */
  editCard: (messageId: number, card: Card) => Promise<void>;
  /** Crea la página en Notion (adjuntos incluidos) y devuelve la URL + cuántos adjuntos entraron
   * de verdad. Es idempotente por hilo: si ya había página, la devuelve con `yaExistia`. */
  createTask: (p: TaskProposal) => Promise<CreatedInfo>;
  /** Cuántos mails esperan detrás del actual. */
  pendientes: () => number;
  /** Saca de la cola la propuesta indicada y ofrece la siguiente (mensaje NUEVO, para que entre
   * el push). No-op si la cola quedó vacía o si esa propuesta ya no es la activa. */
  advanceQueue: (proposalId: string) => Promise<void>;
  /** Devuelve la propuesta activa al FINAL de la cola y propone la siguiente. */
  postponeActive: () => Promise<void>;
}

/** Procesa un callback tsk:*. */
export async function handleTaskCallback(
  deps: TaskCallbackDeps,
  chatId: number,
  messageId: number,
  data: string,
): Promise<void> {
  const parsed = parseTaskCallback(data);
  if (!parsed) return;
  const { action, proposalId, arg } = parsed;

  const p = await deps.store.getProposal(chatId, proposalId);
  if (!p) {
    await deps.editCard(messageId, renderExpired());
    return;
  }

  switch (action) {
    case "back":
      await deps.store.clearPendingInput(chatId);
      await deps.editCard(messageId, renderProposal(p, { pendientes: deps.pendientes(), proposalId }));
      return;

    case "asg":
      await deps.store.clearPendingInput(chatId);
      await deps.editCard(messageId, renderPeoplePicker(Number(arg ?? 0) || 0, proposalId));
      return;

    case "asgpick": {
      const persona = personByIndex(Number(arg));
      if (!persona) return;
      const next = { ...p, asignadoId: persona.id, asignadoNombre: persona.nombre };
      await deps.store.updateProposal(chatId, proposalId, next);
      // B4 del skill: resuelto el picker, la MISMA ancla vuelve a la vista padre con el valor ya
      // aplicado — nunca un mensaje nuevo.
      await deps.editCard(messageId, renderProposal(next, { pendientes: deps.pendientes(), proposalId }));
      return;
    }

    case "asgw":
      await deps.store.setPendingInput(chatId, { proposalId, field: "asignado", anchorMessageId: messageId });
      await deps.editCard(messageId, renderAskInput("asignado", proposalId));
      return;

    case "fec":
    case "ded": {
      await deps.store.clearPendingInput(chatId);
      const campo = action === "fec" ? "fecha" : "deadline";
      await deps.editCard(messageId, renderDatePicker(campo, deps.today(), proposalId));
      return;
    }

    case "fecs":
    case "deds": {
      const kind = arg as DateShortcut;
      if (!["hoy", "vie", "prox", "no"].includes(kind)) return;
      const valor = resolveShortcut(kind, deps.today());
      const next = action === "fecs" ? { ...p, fecha: valor } : { ...p, deadline: valor };
      await deps.store.updateProposal(chatId, proposalId, next);
      await deps.editCard(messageId, renderProposal(next, { pendientes: deps.pendientes(), proposalId }));
      return;
    }

    case "fecw":
    case "dedw": {
      const campo = action === "fecw" ? "fecha" : "deadline";
      await deps.store.setPendingInput(chatId, { proposalId, field: campo, anchorMessageId: messageId });
      await deps.editCard(messageId, renderAskInput(campo, proposalId));
      return;
    }

    case "later": {
      await deps.store.clearPendingInput(chatId);
      await deps.editCard(messageId, renderPostponed(p, deps.pendientes()));
      await deps.postponeActive();
      return;
    }

    case "no": {
      await deps.store.clearPendingInput(chatId);
      await deps.store.clearProposal(chatId, proposalId);
      deps.log({ msg: "task_proposal_discarded", proposalId, messageId: p.messageId });
      await deps.editCard(messageId, renderDiscarded(p, deps.pendientes()));
      await deps.advanceQueue(proposalId);
      return;
    }

    case "ok": {
      await deps.store.clearPendingInput(chatId);
      // Placeholder ANTES del trabajo: sube adjuntos y escribe en Notion, lo que puede pasar los
      // 60s del lock anti-doble-tap. Sin esto la tarjeta sigue mostrando "✅ Crear tarea" todo ese
      // rato, sin ninguna señal — y un segundo tap, una vez vencido el lock, creaba una segunda
      // página. Quitar el teclado es la protección real; el lock solo cubre la ventana corta.
      await deps.editCard(messageId, renderCreating(p));
      try {
        const info = await deps.createTask(p);
        await deps.store.clearProposal(chatId, proposalId);
        deps.log({ msg: "task_created", proposalId, messageId: p.messageId, threadId: p.threadId, url: info.url });
        await deps.editCard(messageId, renderCreated(p, info, deps.pendientes()));
        await deps.advanceQueue(proposalId);
      } catch (err) {
        // La propuesta NO se borra: el trabajo de Cal ajustando los campos no se pierde por un
        // 500 de Notion, y la cola no avanza hasta que este ítem se resuelva de verdad.
        deps.log({ msg: "task_create_failed", proposalId, err: String(err) });
        await deps.editCard(messageId, renderCreateFailed(p, String(err), proposalId));
      }
      return;
    }

    default:
      deps.log({ msg: "task_unknown_action", action });
      return;
  }
}

export interface TaskInputDeps {
  store: TaskStore;
  notionToken: string;
  today: () => string;
  log: (obj: Record<string, unknown>) => void;
  pendientes: () => number;
  /** Le quita el teclado a la tarjeta que preguntó, sin reescribir su texto (B5 del skill). */
  clearKeyboard: (messageId: number) => Promise<void>;
  /** Manda la tarjeta nueva DEBAJO del mensaje de Cal (B5: la resolución nace en una ancla nueva). */
  sendCard: (card: Card) => Promise<void>;
}

/**
 * Texto libre que responde a un botón ✍️.
 *
 * Devuelve `true` solo si consumió el mensaje. Si el texto no parsea como fecha o persona, NO lo
 * consume: el mensaje sigue su curso normal hacia el agente. Esa distinción es lo que evita que
 * este estado se trague un pedido real de Cal — el gotcha que ya pasó con el modo journal, que
 * intercepta TODO mientras está abierto.
 */
export async function applyTaskInput(
  deps: TaskInputDeps,
  chatId: number,
  text: string,
  /** Prefetcheado por el caller junto al resto de lecturas de KV del mensaje. Se pasa `undefined`
   * solo en tests: leerlo acá agregaría un round-trip Mac→Cloudflare (~100-300ms) a CADA mensaje
   * de texto, incluso cuando no hay nada pendiente. */
  prefetched?: TaskPendingInput | null,
): Promise<boolean> {
  const pending = prefetched !== undefined ? prefetched : await deps.store.getPendingInput(chatId);
  if (!pending) return false;

  const p = await deps.store.getProposal(chatId, pending.proposalId);
  if (!p) {
    await deps.store.clearPendingInput(chatId);
    return false;
  }

  // "cancelar" cierra la espera sin aplicar nada, en cualquiera de los tres campos: es una
  // palabra-comando, nunca un valor (bloque B3/B2b del skill telegram-bot-ux).
  if (CANCELAR.has(normalizeName(text))) {
    await deps.store.clearPendingInput(chatId);
    await deps.clearKeyboard(pending.anchorMessageId);
    await deps.sendCard(renderProposal(p, { pendientes: deps.pendientes(), proposalId: pending.proposalId }));
    return true;
  }

  if (pending.field === "fecha" || pending.field === "deadline") {
    const parsed = parseWrittenDate(text, deps.today());
    if (!parsed) return false; // no era una fecha → que lo conteste el agente

    const next =
      pending.field === "fecha" ? { ...p, fecha: parsed.date } : { ...p, deadline: parsed.date };
    await deps.store.updateProposal(chatId, pending.proposalId, next);
    await deps.store.clearPendingInput(chatId);
    await deps.clearKeyboard(pending.anchorMessageId);
    await deps.sendCard(renderProposal(next, { pendientes: deps.pendientes(), proposalId: pending.proposalId }));
    return true;
  }

  // Persona: el snapshot primero (sin red). Solo si no está entre los 20 se consulta Notion.
  let persona = findPersonInSnapshot(text);
  if (!persona) {
    // Un nombre es texto corto sin puntuación de frase: si Cal escribió un pedido cualquiera, no
    // vale la pena una query a Notion — y sobre todo no vale comerse el mensaje.
    if (!looksLikeName(text)) return false;
    try {
      persona = await findPersonInNotion(text, { notionToken: deps.notionToken });
    } catch (err) {
      deps.log({ msg: "task_person_lookup_failed", err: String(err) });
      persona = null;
    }
  }

  if (!persona) {
    // Sí se consume: el texto parecía un nombre y Cal está respondiendo a la pregunta. Se le
    // vuelve a preguntar en vez de asignarle la tarea a quien no era.
    await deps.clearKeyboard(pending.anchorMessageId);
    await deps.sendCard(renderPersonNotFound(text, pending.proposalId));
    return true;
  }

  const next = { ...p, asignadoId: persona.id, asignadoNombre: persona.nombre };
  await deps.store.updateProposal(chatId, pending.proposalId, next);
  await deps.store.clearPendingInput(chatId);
  await deps.clearKeyboard(pending.anchorMessageId);
  await deps.sendCard(renderProposal(next, { pendientes: deps.pendientes(), proposalId: pending.proposalId }));
  return true;
}

/**
 * Cortesías y respuestas sueltas que pasan el filtro de "parece un nombre" (una palabra, solo
 * letras) pero obviamente no lo son. Sin esta lista, un "gracias" o un "ok" mientras la tarjeta
 * espera una persona se consumía: gastaba una query a Notion y se comía el mensaje.
 */
const NO_ES_NOMBRE = new Set([
  "gracias", "ok", "oka", "okay", "listo", "dale", "hola", "buenas", "si", "no", "bueno",
  "perfecto", "genial", "claro", "obvio", "espera", "esperá", "ya", "ahora", "despues",
  "luego", "chau", "adios", "hecho", "correcto", "exacto", "vale", "bien", "mal", "que",
  "como", "cuando", "quien", "porque", "ayuda", "test", "prueba",
]);

/** Cierra el flujo sin aplicar nada (bloque B2b del skill: "cancelar" nunca es un valor). */
// "nada" queda AFUERA a propósito: sobre un campo de fecha significa "sin fecha" (lo dice la
// propia tarjeta), y como CANCELAR se evalúa primero, incluirlo cambiaba limpiar por cancelar.
const CANCELAR = new Set(["cancelar", "cancela", "olvidalo", "olvídalo", "dejalo", "déjalo"]);

/** Hasta 4 palabras, solo letras (con acentos) y puntos de iniciales — "Maria Elena Canahua" sí,
 * "dame el resumen de la reunión de ayer" no. */
export function looksLikeName(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 3 || t.length > 60) return false;
  const words = t.split(/\s+/);
  if (words.length > 4) return false;
  if (words.length === 1 && NO_ES_NOMBRE.has(normalizeName(t))) return false;
  return words.every((w) => /^[\p{L}][\p{L}'.-]*$/u.test(w));
}
