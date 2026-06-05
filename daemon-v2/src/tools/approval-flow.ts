// Flujo de aprobación multi-item para el bot de Jano.
// El LLM llama `buildApprovalFlowImpl` cuando detecta ≥2 items con decisiones individuales.
// Cada callback `jano-wiz-*` llega como `[callback] jano-wiz-*` y el LLM llama
// `stepApprovalWizardImpl` que edita el mensaje y devuelve el item actual para ejecutar la acción.

import type { CfKv } from "../cf-kv.js";

export interface ApprovalItem {
  id: string;     // ID opaco que el LLM usa para llamar la acción correspondiente
  label: string;  // texto principal visible en el wizard
  meta?: string;  // info secundaria (fuente, fecha, categoría, etc.)
}

interface WizardState {
  items: ApprovalItem[];
  processed: string[];  // IDs ya confirmados/descartados
  currentIdx: number;
  summaryMsgId: number;
  chatId: number;
  confirmVerb: string;
  rejectVerb: string;
  title: string;
}

export interface ApprovalFlowDeps {
  kv: CfKv;
  botToken: string;
  getCurrentChatId: () => number;
}

const WIZ_TTL = 30 * 60; // 30 min

function wizKey(chatId: number): string {
  return `jano-wiz:${chatId}`;
}

async function tg(token: string, method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: { message_id: number }; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{ ok: boolean; result?: { message_id: number }; description?: string }>;
}

function buildSummaryText(title: string, items: ApprovalItem[]): string {
  const n = items.length;
  let text = `📋 <b>${title}</b> (${n} item${n === 1 ? "" : "s"})\n`;
  items.forEach((it, i) => {
    const meta = it.meta ? ` · <i>${it.meta}</i>` : "";
    text += `\n${i + 1}. <b>${it.label}</b>${meta}`;
  });
  return text;
}

type InlineRow = Array<{ text: string; callback_data: string }>;

function buildSummaryKeyboard(n: number, confirmVerb: string, rejectVerb: string): { inline_keyboard: InlineRow[] } {
  const confirmEmoji = confirmVerb.split(" ")[0] ?? "✅";
  const rejectEmoji = rejectVerb.split(" ")[0] ?? "🗑️";
  const rows: InlineRow[] = [
    [{ text: `🔍 Revisar uno a uno (${n})`, callback_data: "jano-wiz-start" }],
  ];
  if (n > 1) {
    rows.push([
      { text: `${confirmEmoji} Todo`, callback_data: "jano-wiz-all-ok" },
      { text: `${rejectEmoji} Todo`, callback_data: "jano-wiz-all-no" },
    ]);
  }
  return { inline_keyboard: rows };
}

function buildWizardText(item: ApprovalItem, doneCount: number, remainingCount: number, title: string): string {
  const meta = item.meta ? `\n<i>${item.meta}</i>` : "";
  const progress = doneCount > 0
    ? `✅ ${doneCount} listo${doneCount === 1 ? "" : "s"} · `
    : "";
  return `📋 ${progress}<b>${remainingCount} restante${remainingCount === 1 ? "" : "s"}</b> — ${title}\n\n<b>${item.label}</b>${meta}`;
}

function buildWizardKeyboard(confirmVerb: string, rejectVerb: string, hasPrev: boolean): { inline_keyboard: InlineRow[] } {
  const rows: InlineRow[] = [
    [
      { text: confirmVerb, callback_data: "jano-wiz-ok" },
      { text: rejectVerb, callback_data: "jano-wiz-no" },
    ],
    [{ text: "⏭️ Saltar", callback_data: "jano-wiz-skip" }],
    hasPrev
      ? [{ text: "⬅️ Anterior", callback_data: "jano-wiz-prev" }, { text: "↩️ Resumen", callback_data: "jano-wiz-back" }]
      : [{ text: "↩️ Resumen", callback_data: "jano-wiz-back" }],
  ];
  return { inline_keyboard: rows };
}

function nextUnprocessed(items: ApprovalItem[], processed: string[], fromIdx: number): number {
  const set = new Set(processed);
  for (let i = fromIdx; i < items.length; i++) {
    if (!set.has(items[i].id)) return i;
  }
  return -1;
}

function prevUnprocessed(items: ApprovalItem[], processed: string[], fromIdx: number): number {
  const set = new Set(processed);
  for (let i = fromIdx; i >= 0; i--) {
    if (!set.has(items[i].id)) return i;
  }
  return -1;
}

async function editMsg(token: string, chatId: number, msgId: number, text: string, replyMarkup?: unknown): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, message_id: msgId, text, parse_mode: "HTML" };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await tg(token, "editMessageText", body);
}

// ===== buildApprovalFlow =====

export async function buildApprovalFlowImpl(
  deps: ApprovalFlowDeps,
  args: { title: string; items: ApprovalItem[]; confirmVerb?: string; rejectVerb?: string },
): Promise<{ ok: boolean; summaryMsgId?: number; error?: string }> {
  const chatId = deps.getCurrentChatId();
  if (!chatId) return { ok: false, error: "No chatId disponible" };

  const confirmVerb = args.confirmVerb ?? "✅ Confirmar";
  const rejectVerb = args.rejectVerb ?? "🗑️ Descartar";

  const res = await tg(deps.botToken, "sendMessage", {
    chat_id: chatId,
    text: buildSummaryText(args.title, args.items),
    parse_mode: "HTML",
    reply_markup: buildSummaryKeyboard(args.items.length, confirmVerb, rejectVerb),
  });

  if (!res.ok) return { ok: false, error: res.description ?? "API error" };

  const summaryMsgId = res.result!.message_id;

  await deps.kv.set(wizKey(chatId), {
    items: args.items,
    processed: [],
    currentIdx: 0,
    summaryMsgId,
    chatId,
    confirmVerb,
    rejectVerb,
    title: args.title,
  } satisfies WizardState, WIZ_TTL);

  return { ok: true, summaryMsgId };
}

// ===== stepApprovalWizard =====

export type WizardAction = "start" | "ok" | "no" | "skip" | "prev" | "back" | "bulk-ok" | "bulk-no";

export interface StepResult {
  action: WizardAction;
  item?: ApprovalItem;       // item actual (para que el LLM ejecute la acción)
  items?: ApprovalItem[];    // para bulk actions: todos los items pendientes
  remaining?: number;        // cuántos quedan sin procesar
  done?: boolean;
  error?: string;
}

export async function stepApprovalWizardImpl(
  deps: ApprovalFlowDeps,
  args: { action: WizardAction },
): Promise<StepResult> {
  const chatId = deps.getCurrentChatId();
  const wizState = await deps.kv.get<WizardState>(wizKey(chatId));

  if (!wizState) {
    return { action: args.action, error: "No hay flujo activo. Usa buildApprovalFlow para crear uno." };
  }

  const { items, processed, confirmVerb, rejectVerb, title, summaryMsgId } = wizState;
  const processedSet = () => new Set(wizState.processed);
  const remaining = () => items.filter((it) => !processedSet().has(it.id));

  // ---- bulk-ok / bulk-no ----
  if (args.action === "bulk-ok" || args.action === "bulk-no") {
    const pending = remaining();
    await deps.kv.delete(wizKey(chatId));
    const verb = args.action === "bulk-ok" ? confirmVerb : rejectVerb;
    await editMsg(deps.botToken, chatId, summaryMsgId,
      `${verb} — ${pending.length} item${pending.length === 1 ? "" : "s"}\n\n${buildSummaryText(title, pending)}`);
    return { action: args.action, items: pending, done: true };
  }

  // ---- back ----
  if (args.action === "back") {
    await deps.kv.delete(wizKey(chatId));
    const rem = remaining();
    if (rem.length === 0) {
      await editMsg(deps.botToken, chatId, summaryMsgId, `✅ ${title} — todos revisados.`);
    } else {
      await editMsg(deps.botToken, chatId, summaryMsgId,
        buildSummaryText(title, rem),
        buildSummaryKeyboard(rem.length, confirmVerb, rejectVerb));
    }
    return { action: "back", done: rem.length === 0 };
  }

  // ---- start ----
  if (args.action === "start") {
    const firstIdx = nextUnprocessed(items, processed, 0);
    if (firstIdx < 0) {
      await deps.kv.delete(wizKey(chatId));
      await editMsg(deps.botToken, chatId, summaryMsgId, `✅ ${title} — todos revisados.`);
      return { action: "start", done: true };
    }
    wizState.currentIdx = firstIdx;
    await deps.kv.set(wizKey(chatId), wizState, WIZ_TTL);
    const item = items[firstIdx];
    const rem0 = remaining().length;
    await editMsg(deps.botToken, chatId, summaryMsgId,
      buildWizardText(item, processed.length, rem0, title),
      buildWizardKeyboard(confirmVerb, rejectVerb, false));
    return { action: "start", item, remaining: rem0 };
  }

  const currentIdx = wizState.currentIdx;
  const currentItem = items[currentIdx];

  // ---- prev / skip (navigation only) ----
  if (args.action === "prev" || args.action === "skip") {
    const targetIdx = args.action === "skip"
      ? nextUnprocessed(items, processed, currentIdx + 1)
      : prevUnprocessed(items, processed, currentIdx - 1);

    if (targetIdx < 0) {
      const hasPrev = prevUnprocessed(items, processed, currentIdx - 1) >= 0;
      const remCur = remaining().length;
      await editMsg(deps.botToken, chatId, summaryMsgId,
        buildWizardText(currentItem, processed.length, remCur, title),
        buildWizardKeyboard(confirmVerb, rejectVerb, hasPrev));
      return { action: args.action, item: currentItem, remaining: remCur };
    }

    wizState.currentIdx = targetIdx;
    await deps.kv.set(wizKey(chatId), wizState, WIZ_TTL);
    const nextItem = items[targetIdx];
    const hasPrev = prevUnprocessed(items, processed, targetIdx - 1) >= 0;
    const remNav = remaining().length;
    await editMsg(deps.botToken, chatId, summaryMsgId,
      buildWizardText(nextItem, processed.length, remNav, title),
      buildWizardKeyboard(confirmVerb, rejectVerb, hasPrev));
    return { action: args.action, item: nextItem, remaining: remNav };
  }

  // ---- ok / no ----
  const newProcessed = [...processed, currentItem.id];
  const nextIdx = nextUnprocessed(items, newProcessed, 0);

  if (nextIdx < 0) {
    await deps.kv.delete(wizKey(chatId));
    await editMsg(deps.botToken, chatId, summaryMsgId, `✅ ${title} — todos revisados.`);
    return { action: args.action, item: currentItem, done: true };
  }

  wizState.processed = newProcessed;
  wizState.currentIdx = nextIdx;
  await deps.kv.set(wizKey(chatId), wizState, WIZ_TTL);

  const nextItem = items[nextIdx];
  const hasPrev = prevUnprocessed(items, newProcessed, nextIdx - 1) >= 0;
  const remOkNo = items.filter((it) => !new Set(newProcessed).has(it.id)).length;
  await editMsg(deps.botToken, chatId, summaryMsgId,
    buildWizardText(nextItem, newProcessed.length, remOkNo, title),
    buildWizardKeyboard(confirmVerb, rejectVerb, hasPrev));

  return { action: args.action, item: currentItem, remaining: remOkNo };
}
