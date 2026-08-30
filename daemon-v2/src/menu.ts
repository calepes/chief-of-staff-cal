/**
 * menu.ts — Menú interactivo de Telegram para Jano (CoS personal de Cal).
 *
 * Convenciones:
 * - callback_data con prefijo "j:" para distinguir de callbacks legacy del worker.
 * - Parse mode: siempre HTML.
 * - Máximo 3 botones por fila, 4 filas totales.
 * - Callbacks de navegación → editMessage con sub-menú (sin LLM).
 * - Callbacks de acción → mensaje sintético en lenguaje natural → LLM.
 */

import { editMessage, answerCallbackQuery, sendMessage } from "@cos/shared";
import type { TelegramUpdate, TelegramCallbackQuery } from "@cos/shared";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface MenuPayload {
  text: string;
  keyboard: InlineKeyboardMarkup;
}

export interface ExpenseJunte {
  id: string;
  nombre: string;
}

const expenseJunteOptions = new Map<number, { juntes: ExpenseJunte[]; expiresAt: number }>();
const expenseJuntePending = new Map<number, { junte: ExpenseJunte; expiresAt: number }>();
const expenseJunteNameInput = new Set<number>();
const EXPENSE_JUNTE_SELECTION_TTL_MS = 15 * 60_000;

export function beginExpenseJunteSelection(chatId: number, juntes: ExpenseJunte[], now = Date.now()): void {
  expenseJunteOptions.set(chatId, { juntes, expiresAt: now + EXPENSE_JUNTE_SELECTION_TTL_MS });
  expenseJunteNameInput.delete(chatId);
}

export function selectExpenseJunte(chatId: number, junteId: string, now = Date.now()): boolean {
  const options = expenseJunteOptions.get(chatId);
  expenseJunteOptions.delete(chatId);
  expenseJunteNameInput.delete(chatId);
  const junte = options && options.expiresAt >= now ? options.juntes.find(item => item.id === junteId) : undefined;
  if (!junte) return false;
  expenseJuntePending.set(chatId, { junte, expiresAt: now + EXPENSE_JUNTE_SELECTION_TTL_MS });
  return true;
}

export function beginExpenseJunteNameInput(chatId: number, now = Date.now()): boolean {
  const options = expenseJunteOptions.get(chatId);
  if (!options || options.expiresAt < now) {
    expenseJunteOptions.delete(chatId);
    return false;
  }
  expenseJunteNameInput.add(chatId);
  return true;
}

export function consumeExpenseJunteNameInput(chatId: number, nombre: string, now = Date.now()): ExpenseJunte | null | undefined {
  if (!expenseJunteNameInput.delete(chatId)) return undefined;
  const normalized = nombre.trim().normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("es");
  const options = expenseJunteOptions.get(chatId);
  const junte = options && options.expiresAt >= now ? options.juntes.find(item =>
    item.nombre.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("es") === normalized,
  ) : undefined;
  expenseJunteOptions.delete(chatId);
  if (!junte) return null;
  expenseJuntePending.set(chatId, { junte, expiresAt: now + EXPENSE_JUNTE_SELECTION_TTL_MS });
  return junte;
}

export function cancelExpenseJunteNameInput(chatId: number): boolean {
  if (!expenseJunteNameInput.delete(chatId)) return false;
  expenseJunteOptions.delete(chatId);
  return true;
}

export function consumeExpenseJunteSelection(chatId: number, now = Date.now()): ExpenseJunte | undefined {
  const selection = expenseJuntePending.get(chatId);
  expenseJuntePending.delete(chatId);
  return selection && selection.expiresAt >= now ? selection.junte : undefined;
}

export function cancelExpenseJunteSelection(chatId: number): void {
  expenseJunteOptions.delete(chatId);
  expenseJuntePending.delete(chatId);
  expenseJunteNameInput.delete(chatId);
}

export function buildExpenseJunteMenu(juntes: ExpenseJunte[]): MenuPayload {
  return {
    text: "📅 <b>¿A qué junte corresponde?</b>\nSelecciona el junte del gasto.",
    keyboard: {
      inline_keyboard: [
        ...juntes.slice(0, 6).reduce<InlineKeyboardButton[][]>((rows, junte, index) => {
          if (index % 2 === 0) rows.push([]);
          const label = junte.nombre.length > 17 ? `${junte.nombre.slice(0, 16).trimEnd()}…` : junte.nombre;
          rows.at(-1)!.push({ text: `📅 ${label}`, callback_data: `j:achoradazos:gasto:junte:${junte.id}` });
          return rows;
        }, []),
        [
          { text: "✏️ Otro", callback_data: "j:achoradazos:gasto:otro" },
          { text: "❌ Cancelar", callback_data: "j:achoradazos:gasto:cancelar" },
        ],
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Menús
// ---------------------------------------------------------------------------

export function buildMainMenu(): MenuPayload {
  return {
    text: "🎯 <b>¿En qué te ayudo, Cal?</b>",
    keyboard: {
      inline_keyboard: [
        [
          { text: "🏠 Personal", callback_data: "j:personal" },
          { text: "🩺 Salud", callback_data: "j:health" },
          { text: "📚 Learning", callback_data: "j:learning" },
        ],
        [
          { text: "✈️ Viajes", callback_data: "j:viajes" },
          { text: "💼 Yape", callback_data: "j:yape" },
          { text: "💰 Finanzas", callback_data: "j:fx" },
        ],
        [
          { text: "🚗 Combustible", callback_data: "j:fuel" },
          { text: "⚡ Tokens", callback_data: "j:tokens" },
          { text: "💻 Claude Launcher", callback_data: "j:launcher" },
        ],
        [
          { text: "📋 Backlog", callback_data: "j:backlog" },
          { text: "📓 Journal", callback_data: "j:journal" },
          { text: "🇵🇪 Achoradazos", callback_data: "j:achoradazos" },
        ],
      ],
    },
  };
}

// Teclado persistente bajo el campo de texto: un botón "📋 Menú" siempre visible en el chat
// para abrir el menú principal sin escribir /menu. Se fija adjuntándolo a cualquier sendMessage.
export const MENU_REPLY_KEYBOARD = {
  keyboard: [[{ text: "📋 Menú" }]],
  resize_keyboard: true,
  is_persistent: true,
};

export function buildPersonalMenu(): MenuPayload {
  return {
    text: "🏠 <b>Personal</b> — ¿qué necesitás?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "📋 Tareas hoy", callback_data: "j:personal:things-today" },
          { text: "📁 Proyectos", callback_data: "j:personal:things-projects" },
          { text: "👪 Reminders", callback_data: "j:personal:reminders" },
        ],
        [{ text: "← Volver", callback_data: "j:menu" }],
      ],
    },
  };
}

export function buildHealthMenu(): MenuPayload {
  return {
    text: "🏥 <b>Salud</b> — ¿Qué datos?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "📊 Resumen", callback_data: "j:health:sum" },
          { text: "📈 Tendencia", callback_data: "j:health:trend" },
          { text: "💪 Workouts", callback_data: "j:health:work" },
        ],
        [{ text: "🎯 Foco CAL", callback_data: "j:health:foco" }],
        [{ text: "← Volver", callback_data: "j:menu" }],
      ],
    },
  };
}

export function buildLearningMenu(): MenuPayload {
  return {
    text: "📚 <b>Learning</b> — ¿qué necesitás?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "⭐ Starred", callback_data: "j:star" },
          { text: "🎬 Playlist", callback_data: "j:ytpl" },
          { text: "📚 Resumir", callback_data: "j:resumir" },
        ],
        [
          { text: "📋 Estado", callback_data: "j:estado" },
          { text: "✨ Readwise", callback_data: "j:learning:readwise" },
          { text: "📖 Reader", callback_data: "j:learning:reader" },
        ],
        [
          { text: "📰 Feedbin", callback_data: "j:learning:feedbin" },
          { text: "📕 Libros", callback_data: "j:learning:libros" },
        ],
        [{ text: "← Volver", callback_data: "j:menu" }],
      ],
    },
  };
}

export function buildViajesMenu(): MenuPayload {
  return {
    text: "✈️ <b>Viajes</b> — ¿qué necesitás?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "✈️ Vuelos", callback_data: "j:flights" },
          { text: "🛂 QR Aduana", callback_data: "j:viajes:qr" },
          { text: "✅ Check-in BoA", callback_data: "j:viajes:boa" },
        ],
        [{ text: "← Volver", callback_data: "j:menu" }],
      ],
    },
  };
}

export function buildYapeMenu(): MenuPayload {
  return {
    text: "💼 <b>Yape</b> — ¿qué necesitás?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "📊 KPI cards", callback_data: "j:yape:kpi" },
          { text: "📅 Meetings", callback_data: "j:yape:meetings" },
          { text: "🎤 PPT wizard", callback_data: "j:yape:ppt" },
        ],
        [{ text: "🌧️ Lluvia/pronóstico", callback_data: "j:yape:lluvia" }],
        [{ text: "← Volver", callback_data: "j:menu" }],
      ],
    },
  };
}

export function buildCambioMenu(): MenuPayload {
  return {
    text: "💰 <b>Tipo de cambio</b> — ¿Qué tasa?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "🏦 BCB", callback_data: "j:fx:bcb" },
          { text: "💹 P2P Binance", callback_data: "j:fx:p2p" },
          { text: "📊 Ambos", callback_data: "j:fx:all" },
        ],
        [{ text: "📈 Inversiones", callback_data: "j:fx:inversiones" }],
        [{ text: "← Volver", callback_data: "j:menu" }],
      ],
    },
  };
}

export function buildAchoradazosMenu(): MenuPayload {
  return {
    text: "🇵🇪 <b>Achoradazos</b> — ¿qué gestionamos?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "💰 Grupos de cobro", callback_data: "j:achoradazos:cobros" },
          { text: "📅 Juntes", callback_data: "j:achoradazos:juntes" },
        ],
        [
          { text: "🧾 Registrar pago", callback_data: "j:achoradazos:pago" },
          { text: "➕ Nuevo grupo", callback_data: "j:achoradazos:nuevo-cobro" },
        ],
        [
          { text: "💸 Registrar gasto", callback_data: "j:achoradazos:gasto" },
          { text: "➕ Nuevo junte", callback_data: "j:achoradazos:nuevo-junte" },
        ],
        [{ text: "← Volver", callback_data: "j:menu" }],
      ],
    },
  };
}

export function buildFlightsMenu(): MenuPayload {
  return {
    text: "✈️ <b>Vuelos</b> — ¿qué aeropuerto?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "Santa Cruz VVI", callback_data: "j:flights:vvi" },
          { text: "La Paz LPB",     callback_data: "j:flights:lpb" },
          { text: "Cochabamba CBB", callback_data: "j:flights:cbb" },
        ],
        [
          { text: "Tarija TJA",     callback_data: "j:flights:tja" },
          { text: "Sucre SRE",      callback_data: "j:flights:sre" },
          { text: "Oruro ORU",      callback_data: "j:flights:oru" },
        ],
        [{ text: "← Volver", callback_data: "j:viajes" }],
      ],
    },
  };
}

function buildFlightsDirMenu(code: string, name: string): MenuPayload {
  return {
    text: `✈️ <b>${code} · ${name}</b> — ¿salidas o llegadas?`,
    keyboard: {
      inline_keyboard: [
        [
          { text: "🛫 Salidas hoy",  callback_data: `j:flights:${code.toLowerCase()}:dep` },
          { text: "🛬 Llegadas hoy", callback_data: `j:flights:${code.toLowerCase()}:arr` },
        ],
        [{ text: "← Aeropuertos", callback_data: "j:flights" }],
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Mapeo acción → texto natural para el LLM
// ---------------------------------------------------------------------------

export const ACTION_TEXT: Record<string, string> = {
  // j:star y j:ytpl son MECÁNICOS (se interceptan en index.ts y editan el mensaje tocado como ancla).
  "j:resumir": "Quiero resumir un link o título de libro; pídeme cuál es.",
  "j:estado": "Dame el estado del resumidor: qué hay en curso y en cola (playlist y starred).",
  "j:resu:tag": "Quiero agregar uno o más tags al resumen pendiente ANTES de guardar. Preguntame en una línea qué tag(s) agregar; cuando responda, llamá mcp__cos-tools__editarPropuestaResumen con addTags. NO guardes todavía.",
  "j:resu:edit": "Quiero editar los highlights o tags del resumen pendiente. Preguntame en una línea qué cambiar; usá mcp__cos-tools__editarPropuestaResumen (setTags / removeHighlights / retag). NO guardes hasta que confirme.",
  "j:health:sum": "Dame un resumen de mi salud",
  "j:health:trend": "Muéstrame la tendencia de mi salud",
  "j:health:work": "Muéstrame mis workouts recientes",
  "j:health:foco": "Dame el estado de mi Foco CAL",
  "j:fx:bcb": "¿Cuál es el tipo de cambio BCB oficial hoy?",
  "j:fx:p2p": "¿Cuál es la tasa P2P de Binance ahora?",
  "j:fx:all": "Dame el tipo de cambio BCB oficial y P2P Binance",
  "j:fx:inversiones": "Dame el resumen de mi portafolio de inversiones",
  "j:achoradazos:cobros": "Muéstrame los grupos de cobro de Achoradazos para elegir uno.",
  "j:achoradazos:juntes": "Muéstrame los juntes de Achoradazos para elegir uno.",
  "j:achoradazos:pago": "Quiero registrar un pago de Achoradazos. Pídeme el comprobante y, antes de registrarlo, muéstrame los grupos de cobro y juntes para que elija ambos explícitamente.",
  "j:achoradazos:gasto": "Quiero registrar un gasto de Achoradazos. Pídeme proveedor, concepto, monto, fecha y comprobante; antes de registrarlo, muéstrame los juntes para que elija uno explícitamente.",
  "j:achoradazos:nuevo-cobro": "Quiero crear un nuevo grupo de cobro de Achoradazos. Pregúntame nombre, monto por persona y cantidad.",
  "j:achoradazos:nuevo-junte": "Quiero crear un nuevo junte de Achoradazos. Pregúntame nombre, fecha y lugar.",
  "j:fuel": "Muéstrame las gasolineras con combustible disponible en Santa Cruz",
  "j:tokens": "¿Cuánto presupuesto de Claude Max llevo hoy?",
  "j:launcher": "Muéstrame los proyectos del Claude Launcher",
  "j:backlog": "Muéstrame el mapa de mis backlogs",
  "j:personal:things-today": "Muéstrame mis tareas de hoy en Todoist",
  "j:personal:things-projects": "Muéstrame mis proyectos de Todoist",
  "j:personal:reminders": "Muéstrame los reminders de hoy de familia y mercado",
  "j:learning:readwise": "Dame mi daily review de Readwise",
  "j:learning:reader": "Muéstrame lo nuevo en mi inbox de Readwise Reader",
  "j:learning:feedbin": "Muéstrame lo no leído de Feedbin",
  "j:learning:libros": "Muéstrame mis libros recientes",
  "j:viajes:qr": "Quiero generar el QR de aduana de Bolivia",
  "j:viajes:boa": "Quiero hacer el check-in de mi próximo vuelo de BoA",
  "j:yape:kpi": "Muéstrame las KPI cards de Yape de hoy",
  "j:yape:meetings": "Muéstrame mis meetings",
  "j:yape:ppt": "Retoma mi último PPT wizard",
  "j:yape:lluvia": "Quiero datos de lluvia en Bolivia. Preguntame en una línea, sin asumir nada: ¿reporte medido (¿de qué ciudad y qué fecha?) o pronóstico (¿de qué ciudad y cuántos días?)?",
  "j:flights:vvi:dep": "Muéstrame las salidas de hoy desde VVI (Viru Viru, Santa Cruz)",
  "j:flights:vvi:arr": "Muéstrame las llegadas de hoy a VVI (Viru Viru, Santa Cruz)",
  "j:flights:lpb:dep": "Muéstrame las salidas de hoy desde LPB (El Alto, La Paz)",
  "j:flights:lpb:arr": "Muéstrame las llegadas de hoy a LPB (El Alto, La Paz)",
  "j:flights:cbb:dep": "Muéstrame las salidas de hoy desde CBB (Cochabamba)",
  "j:flights:cbb:arr": "Muéstrame las llegadas de hoy a CBB (Cochabamba)",
  "j:flights:tja:dep": "Muéstrame las salidas de hoy desde TJA (Tarija)",
  "j:flights:tja:arr": "Muéstrame las llegadas de hoy a TJA (Tarija)",
  "j:flights:sre:dep": "Muéstrame las salidas de hoy desde SRE (Sucre)",
  "j:flights:sre:arr": "Muéstrame las llegadas de hoy a SRE (Sucre)",
  "j:flights:oru:dep": "Muéstrame las salidas de hoy desde ORU (Oruro)",
  "j:flights:oru:arr": "Muéstrame las llegadas de hoy a ORU (Oruro)",
};

// Callbacks de navegación pura (solo editan el mensaje, sin LLM)
export const NAV_MENUS: Record<string, () => MenuPayload> = {
  "j:menu": buildMainMenu,
  "j:personal": buildPersonalMenu,
  "j:health": buildHealthMenu,
  "j:learning": buildLearningMenu,
  "j:viajes": buildViajesMenu,
  "j:yape": buildYapeMenu,
  "j:fx": buildCambioMenu,
  "j:achoradazos": buildAchoradazosMenu,
  "j:flights": buildFlightsMenu,
  "j:flights:vvi": () => buildFlightsDirMenu("VVI", "Viru Viru (SCZ)"),
  "j:flights:lpb": () => buildFlightsDirMenu("LPB", "El Alto (LPZ)"),
  "j:flights:cbb": () => buildFlightsDirMenu("CBB", "Jorge Wilstermann"),
  "j:flights:tja": () => buildFlightsDirMenu("TJA", "Oriel Lea Plaza"),
  "j:flights:sre": () => buildFlightsDirMenu("SRE", "Alcantarí"),
  "j:flights:oru": () => buildFlightsDirMenu("ORU", "Juan Méndez"),
};

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------

/**
 * Maneja callbacks con prefijo "j:".
 *
 * @param cb              - Objeto callback_query de Telegram.
 * @param token           - Bot token de Jano.
 * @param processMessageFn - Función processMessage de index.ts (para callbacks de acción).
 * @param updateId        - update_id del TelegramUpdate original.
 */
export async function handleMenuCallback(
  cb: TelegramCallbackQuery,
  token: string,
  processMessageFn: (payload: TelegramUpdate, queueWaitMs: number, opts?: { existingPlaceholderId?: number }) => Promise<void>,
  updateId: number,
  listExpenseJuntes: () => Promise<ExpenseJunte[]>,
): Promise<void> {
  const data = cb.data ?? "";
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;

  // Siempre dismissar el spinner de Telegram
  void answerCallbackQuery(token, cb.id).catch(() => {});

  if (data === "j:achoradazos:gasto") {
    if (chatId == null || messageId == null) return;
    try {
      await editMessage(token, chatId, messageId, "⏳ Consultando juntes...", "HTML");
      const juntes = await listExpenseJuntes();
      if (juntes.length === 0) {
        await editMessage(token, chatId, messageId, "⚠️ No hay juntes disponibles. Crea uno antes de registrar el gasto.", "HTML");
        return;
      }
      beginExpenseJunteSelection(chatId, juntes);
      const menu = buildExpenseJunteMenu(juntes);
      await editMessage(token, chatId, messageId, menu.text, "HTML", menu.keyboard);
    } catch {
      await editMessage(token, chatId, messageId, "⚠️ No pude cargar los juntes. Inténtalo de nuevo.", "HTML", {
        inline_keyboard: [
          [{ text: "🔄 Reintentar", callback_data: "j:achoradazos:gasto" }],
          [{ text: "❌ Cancelar", callback_data: "j:achoradazos:gasto:cancelar" }],
        ],
      });
    }
    return;
  }

  if (data.startsWith("j:achoradazos:gasto:junte:")) {
    if (chatId == null || messageId == null) return;
    const junteId = data.slice("j:achoradazos:gasto:junte:".length);
    if (!selectExpenseJunte(chatId, junteId)) {
      return;
    }
    await editMessage(token, chatId, messageId, "✅ <b>Junte seleccionado</b>\n\nAdjunta el comprobante del gasto. Espero tu recibo.", "HTML", { inline_keyboard: [] });
    return;
  }

  if (data === "j:achoradazos:gasto:otro") {
    if (chatId == null || messageId == null) return;
    if (!beginExpenseJunteNameInput(chatId)) {
      await editMessage(token, chatId, messageId, "⚠️ Esa selección venció. Vuelve a iniciar el registro de gasto.", "HTML", { inline_keyboard: [] });
      return;
    }
    await editMessage(token, chatId, messageId, "✏️ <b>Otro junte</b>\n\nEscribe el nombre completo del junte.", "HTML", { inline_keyboard: [] });
    return;
  }

  if (data === "j:achoradazos:gasto:cancelar") {
    if (chatId == null || messageId == null) return;
    cancelExpenseJunteSelection(chatId);
    await editMessage(token, chatId, messageId, "❌ Registro de gasto cancelado.", "HTML", { inline_keyboard: [] });
    return;
  }

  // --- Navegación pura ---
  if (data in NAV_MENUS) {
    if (chatId == null || messageId == null) return;
    const menu = NAV_MENUS[data]();
    await editMessage(token, chatId, messageId, menu.text, "HTML", menu.keyboard);
    return;
  }

  // --- Acción → LLM (Option B: el mensaje de menú se convierte en placeholder) ---
  const naturalText = ACTION_TEXT[data];
  if (!naturalText) return;
  if (!cb.message) return;

  const menuMsgId = cb.message.message_id;
  const actionChatId = cb.message.chat.id;

  // 1. El menú se edita a ⏳ (queda como placeholder, sin teclado)
  await editMessage(token, actionChatId, menuMsgId, "⏳ Pensando...", "HTML");

  // 2. Update sintético usando el mismo chat
  const synthetic: TelegramUpdate = {
    update_id: updateId,
    message: {
      message_id: menuMsgId,
      chat: cb.message.chat,
      date: Math.floor(Date.now() / 1000),
      text: naturalText,
      from: cb.from ? { id: cb.from.id, first_name: cb.from.first_name } : undefined,
    },
  };

  // 3. LLM reemplaza el placeholder con la respuesta
  await processMessageFn(synthetic, 0, { existingPlaceholderId: menuMsgId });
}
