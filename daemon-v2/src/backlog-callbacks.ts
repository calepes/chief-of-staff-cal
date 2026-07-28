// backlog-callbacks.ts — callbacks bklg:* del flujo de backlog.
//
// Todos son MECÁNICOS (sin LLM) y HEAVY (escriben a disco), así que en index.ts van con el lock
// anti-doble-tap de cf-kv.ts, igual que jnl:* y mlog:/mskip:/msel:.
//
// El módulo no toca la red directamente: recibe `editCard` como dependencia para poder testear
// el flujo completo sin mockear fetch.

import {
  renderSaved,
  renderDiscarded,
  renderDestPicker,
  renderAddProposal,
  renderDoneProposal,
} from "./backlog-card.js";
import { discoverBacklogs, resolveBacklogPath } from "./tools/backlog-discovery.js";
import { buildBacklogMap } from "./tools/backlog-read.js";
import { appendBacklogItem, markBacklogDone } from "./tools/backlog-write.js";
import type { BacklogStore } from "./backlog-store.js";

export interface BacklogCallbackDeps {
  store: BacklogStore;
  /** Root del árbol de proyectos. Parametrizado para tests. */
  root: string;
  /** Fecha YYYY-MM-DD de la sección a usar. Parametrizada para tests. */
  today: string;
  log: (obj: Record<string, unknown>) => void;
  editCard: (chatId: number, messageId: number, text: string, keyboard?: unknown) => Promise<void>;
}

export function isBacklogCallback(data: string | undefined): boolean {
  return typeof data === "string" && data.startsWith("bklg:");
}

/** Parse mode HTML (skill telegram-bot-ux): escapar solo < > &. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function labelFor(key: string, root: string): string {
  return discoverBacklogs(root).find((e) => e.key === key)?.label ?? key;
}

export async function handleBacklogCallback(
  deps: BacklogCallbackDeps,
  chatId: number,
  messageId: number,
  data: string,
): Promise<void> {
  const [, action, shortId, extra] = data.split(":");
  const prop = await deps.store.getProposal(chatId, shortId);

  if (!prop) {
    await deps.editCard(chatId, messageId, "⌛ <b>Esa propuesta expiró.</b> Díctamela de nuevo.", {
      inline_keyboard: [],
    });
    return;
  }

  if (action === "drop") {
    await deps.store.clearProposal(chatId, shortId);
    const card = renderDiscarded();
    await deps.editCard(chatId, messageId, card.text, card.keyboard);
    return;
  }

  if (action === "dest") {
    const rows = buildBacklogMap(discoverBacklogs(deps.root));
    const card = renderDestPicker(rows, shortId);
    await deps.editCard(chatId, messageId, card.text, card.keyboard);
    return;
  }

  // Escape del picker (bloque B5 del skill telegram-bot-ux: corte de ancla por texto). Se le
  // quita el teclado a esta tarjeta y se le pide a Cal que escriba el proyecto. Su mensaje va al
  // LLM, que vuelve a llamar proponerItemBacklog con la clave correcta y nace una tarjeta NUEVA
  // debajo de lo que Cal escribió — nunca se reescribe esta, que quedaría posicionada arriba de
  // su mensaje.
  //
  // No se guarda estado de "esperando respuesta": el LLM ya tiene la conversación y el texto del
  // ítem está acá en el mensaje. Un pendingEdit propio sería estado extra que se puede desincronizar.
  if (action === "destother") {
    const claves = discoverBacklogs(deps.root).map((e) => `• <code>${e.key}</code>`).join("\n");
    await deps.editCard(
      chatId,
      messageId,
      `📁 <b>¿A qué proyecto?</b>\nEscríbeme el nombre y lo anoto ahí.\n\n${claves}`,
      { inline_keyboard: [] },
    );
    return;
  }

  // Botón "✏️ Editar texto" (bloque B5 del skill telegram-bot-ux, mismo patrón que `destother`
  // arriba): se le quita el teclado a esta tarjeta y se le pide a Cal que reescriba el texto,
  // mostrándole el ítem actual para que tenga contexto de qué está corrigiendo. Su mensaje va al
  // LLM, que vuelve a llamar proponerItemBacklog con el texto corregido y nace una tarjeta NUEVA
  // debajo — nunca se reescribe esta.
  //
  // No se guarda un `pendingEdit`: el LLM ya tiene la conversación entera y el texto actual del
  // ítem queda visible acá mismo en el mensaje. Un estado propio de "editando" sería estado extra
  // que se puede desincronizar — la misma decisión que ya se tomó para `destother`.
  if (action === "edit") {
    await deps.editCard(
      chatId,
      messageId,
      `✏️ <b>¿Cómo lo dejo?</b>\nTexto actual: «${esc(prop.text)}»\n\nEscríbeme el texto nuevo y armo la tarjeta de nuevo.`,
      { inline_keyboard: [] },
    );
    return;
  }

  if (action === "destpick") {
    await deps.store.updateProposal(chatId, shortId, { ...prop, key: extra });
    const label = labelFor(extra, deps.root);
    const card =
      prop.kind === "add"
        ? renderAddProposal(label, prop.text, shortId)
        : renderDoneProposal(label, prop.text, shortId);
    await deps.editCard(chatId, messageId, card.text, card.keyboard);
    return;
  }

  if (action !== "save") return;

  let path: string;
  try {
    path = resolveBacklogPath(prop.key, deps.root);
  } catch (e) {
    deps.log({ msg: "backlog_resolve_failed", key: prop.key, err: String(e) });
    await deps.editCard(chatId, messageId, `⚠️ ${e instanceof Error ? e.message : String(e)}`, {
      inline_keyboard: [],
    });
    return;
  }

  const label = labelFor(prop.key, deps.root);

  if (prop.kind === "add") {
    appendBacklogItem(path, prop.text, deps.today);
    await deps.store.clearProposal(chatId, shortId);
    const card = renderSaved(label, prop.text, "add");
    await deps.editCard(chatId, messageId, card.text, card.keyboard);
    deps.log({ msg: "backlog_item_added", key: prop.key });
    return;
  }

  const res = markBacklogDone(path, prop.text);
  if (res.ok) {
    await deps.store.clearProposal(chatId, shortId);
    const card = renderSaved(label, res.line, "done");
    await deps.editCard(chatId, messageId, card.text, card.keyboard);
    deps.log({ msg: "backlog_item_done", key: prop.key });
    return;
  }

  const msg =
    res.reason === "not_found"
      ? "⚠️ No encontré ese ítem entre los pendientes. Revisa el texto y pídemelo de nuevo."
      : `⚠️ Encontré <b>más de un</b> ítem que coincide:\n${res.candidates
          .map((c) => `• ${c.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`)
          .join("\n")}\nDime cuál con más precisión.`;
  await deps.editCard(chatId, messageId, msg, { inline_keyboard: [] });
}
