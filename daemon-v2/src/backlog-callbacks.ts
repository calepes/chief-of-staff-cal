// backlog-callbacks.ts — callbacks bklg:* del flujo de backlog.
//
// Todos son MECÁNICOS (sin LLM) y HEAVY (escriben a disco), así que en index.ts van con el lock
// anti-doble-tap de cf-kv.ts, igual que jnl:* y mlog:/mskip:/msel:.
//
// El módulo no toca la red directamente: recibe `editCard` como dependencia para poder testear
// el flujo completo sin mockear fetch.

import { readFileSync } from "node:fs";
import {
  renderSaved,
  renderDiscarded,
  renderDestPicker,
  renderAddProposal,
  renderDoneProposal,
  renderDiscardProposal,
} from "./backlog-card.js";
import { discoverBacklogs, resolveBacklogPath } from "./tools/backlog-discovery.js";
import { buildBacklogMap } from "./tools/backlog-read.js";
import {
  appendBacklogItem,
  markBacklogDone,
  markBacklogDiscarded,
  restoreBacklogSnapshot,
} from "./tools/backlog-write.js";
import type { BacklogStore } from "./backlog-store.js";
import type { MarkResult } from "./backlog-types.js";

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

/** Mensaje ante un fallo de escritura: sin stack ni path absoluto, entendible para Cal. */
const WRITE_FAIL_MSG =
  "⚠️ <b>No pude guardar el cambio en el backlog.</b> Puede ser un problema pasajero de disco — intenta de nuevo en un momento.";

export async function handleBacklogCallback(
  deps: BacklogCallbackDeps,
  chatId: number,
  messageId: number,
  data: string,
): Promise<void> {
  const [, action, shortId, extra] = data.split(":");

  // ↩️ Deshacer usa el shortId de una propuesta YA escrita y limpiada de KV — no busca `prop`,
  // así que va antes del chequeo de "propuesta expirada" de abajo (ese es para el flujo de
  // confirmación, no para deshacer algo que ya se confirmó).
  if (action === "undo") {
    const snapshot = await deps.store.getUndo(chatId, shortId);
    if (!snapshot) {
      await deps.editCard(chatId, messageId, "⌛ <b>La ventana para deshacer ya pasó.</b>", {
        inline_keyboard: [],
      });
      return;
    }
    try {
      restoreBacklogSnapshot(snapshot.path, snapshot.content);
    } catch (e) {
      deps.log({ msg: "backlog_undo_failed", err: String(e) });
      await deps.editCard(chatId, messageId, WRITE_FAIL_MSG, { inline_keyboard: [] });
      return;
    }
    await deps.store.clearUndo(chatId, shortId);
    await deps.editCard(chatId, messageId, "↩️ <b>Deshecho</b> · el backlog volvió a como estaba.", {
      inline_keyboard: [],
    });
    deps.log({ msg: "backlog_undone" });
    return;
  }

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
      `📁 <b>¿A qué proyecto?</b>\nEscríbeme el nombre y lo anoto ahí.\n\n«${esc(prop.text)}»\n\n${claves}`,
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
    let newPath: string;
    try {
      newPath = resolveBacklogPath(extra, deps.root);
    } catch (e) {
      deps.log({ msg: "backlog_resolve_failed", key: extra, err: String(e) });
      await deps.editCard(chatId, messageId, `⚠️ ${e instanceof Error ? e.message : String(e)}`, {
        inline_keyboard: [],
      });
      return;
    }
    await deps.store.updateProposal(chatId, shortId, { ...prop, key: extra, path: newPath });
    const label = labelFor(extra, deps.root);
    const card =
      prop.kind === "add"
        ? renderAddProposal(label, prop.text, shortId)
        : prop.kind === "done"
          ? renderDoneProposal(label, prop.text, shortId)
          : renderDiscardProposal(label, prop.text, shortId);
    await deps.editCard(chatId, messageId, card.text, card.keyboard);
    return;
  }

  if (action !== "save") {
    deps.log({ msg: "backlog_unknown_action", action });
    return;
  }

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
  // path resuelto arriba es la única fuente confiable para escribir (realpath + allowlist,
  // revalidados en cada save). prop.path es solo el snapshot guardado al crear la propuesta —
  // si difieren, el árbol cambió entre proponer y confirmar (ventana de hasta 1h de TTL); se
  // loguea para poder auditarlo, nunca se usa para saltarse la revalidación.
  if (prop.path !== path) {
    deps.log({ msg: "backlog_path_mismatch", key: prop.key, proposedPath: prop.path, resolvedPath: path });
  }

  const label = labelFor(prop.key, deps.root);

  // Snapshot ANTES de escribir — es lo que restaura ↩️ Deshacer. Si ni siquiera se puede leer
  // el archivo acá, tampoco se va a poder escribir abajo: cada rama de escritura ya tiene su
  // propio try/catch que va a fallar con el mismo error y avisar a Cal, así que no hace falta
  // uno extra acá — con "" alcanza como snapshot inútil-pero-inofensivo en ese caso límite.
  let snapshot = "";
  try {
    snapshot = readFileSync(path, "utf8");
  } catch {
    /* el catch de la escritura de abajo va a fallar igual y avisar */
  }

  // Mismo patrón: la escritura es el paso que más importa (es la única razón de ser de toda la
  // tarjeta) y puede fallar por causas ajenas a la propuesta (ENOSPC, EACCES, volumen de solo
  // lectura, el archivo se borró entre el realpath y acá). Sin este try/catch la excepción sube
  // hasta el `.catch` genérico de index.ts y la tarjeta queda con los botones vivos — Cal ve
  // exactamente lo mismo que antes de tocar ✅, sin ningún indicio de que su escritura no se guardó.
  if (prop.kind === "add") {
    try {
      appendBacklogItem(path, prop.text, deps.today);
    } catch (e) {
      deps.log({ msg: "backlog_write_failed", key: prop.key, kind: "add", err: String(e) });
      await deps.editCard(chatId, messageId, WRITE_FAIL_MSG, { inline_keyboard: [] });
      return;
    }
    await deps.store.setUndo(chatId, shortId, { path, content: snapshot });
    await deps.store.clearProposal(chatId, shortId);
    const card = renderSaved(label, prop.text, "add", shortId);
    await deps.editCard(chatId, messageId, card.text, card.keyboard);
    deps.log({ msg: "backlog_item_added", key: prop.key });
    return;
  }

  let res: MarkResult;
  try {
    res =
      prop.kind === "done"
        ? markBacklogDone(path, prop.text)
        : markBacklogDiscarded(path, prop.text, deps.today);
  } catch (e) {
    deps.log({ msg: "backlog_write_failed", key: prop.key, kind: prop.kind, err: String(e) });
    await deps.editCard(chatId, messageId, WRITE_FAIL_MSG, { inline_keyboard: [] });
    return;
  }
  if (res.ok) {
    await deps.store.setUndo(chatId, shortId, { path, content: snapshot });
    await deps.store.clearProposal(chatId, shortId);
    const card = renderSaved(label, res.line, prop.kind, shortId);
    await deps.editCard(chatId, messageId, card.text, card.keyboard);
    deps.log({ msg: prop.kind === "done" ? "backlog_item_done" : "backlog_item_discarded", key: prop.key });
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
