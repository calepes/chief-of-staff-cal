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

// ---------------------------------------------------------------------------
// Menús
// ---------------------------------------------------------------------------

export function buildMainMenu(): MenuPayload {
  return {
    text: "🎯 <b>¿En qué te ayudo, Cal?</b>",
    keyboard: {
      inline_keyboard: [
        [
          { text: "🔮 Briefing", callback_data: "j:brief" },
          { text: "📋 Tareas", callback_data: "j:tasks" },
          { text: "📅 Agenda", callback_data: "j:cal" },
        ],
        [
          { text: "🏥 Salud", callback_data: "j:health" },
          { text: "💰 Cambio", callback_data: "j:fx" },
          { text: "🚗 Combustible", callback_data: "j:fuel" },
        ],
        [
          { text: "✈️ Vuelos", callback_data: "j:flights" },
          { text: "⚡ Tokens", callback_data: "j:tokens" },
          { text: "🃏 Álbum",  callback_data: "j:panini"  },
        ],
      ],
    },
  };
}

export function buildBriefingMenu(): MenuPayload {
  return {
    text: "🔮 <b>Briefing</b> — ¿Qué país?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "🌐 Bolivia", callback_data: "j:brief:bo" },
          { text: "🇵🇪 Perú", callback_data: "j:brief:pe" },
          { text: "🌎 Colombia", callback_data: "j:brief:co" },
        ],
        [{ text: "← Volver", callback_data: "j:menu" }],
      ],
    },
  };
}

export function buildTasksMenu(): MenuPayload {
  return {
    text: "📋 <b>Tareas</b> — ¿Qué lista?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "👤 Personal", callback_data: "j:tasks:personal" },
          { text: "⚡ Vibe", callback_data: "j:tasks:vibe" },
        ],
        [
          { text: "➕ Nueva", callback_data: "j:tasks:new" },
          { text: "← Volver", callback_data: "j:menu" },
        ],
      ],
    },
  };
}

export function buildAgendaMenu(): MenuPayload {
  return {
    text: "📅 <b>Agenda</b> — ¿Qué rango?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "📅 Hoy", callback_data: "j:cal:today" },
          { text: "🗓 Esta semana", callback_data: "j:cal:week" },
        ],
        [
          { text: "💼 Outlook", callback_data: "j:cal:outlook" },
          { text: "➕ Nuevo evento", callback_data: "j:cal:new" },
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
        [{ text: "← Volver", callback_data: "j:menu" }],
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
// Álbum Panini FIFA World Cup 2026
// ---------------------------------------------------------------------------

const PANINI_NAMES: Record<string, string> = {
  // CONMEBOL
  ARG: "Argentina",      BRA: "Brasil",         COL: "Colombia",
  URU: "Uruguay",        ECU: "Ecuador",        VEN: "Venezuela",      PAR: "Paraguay",
  // UEFA p1
  GER: "Alemania",       FRA: "Francia",        ESP: "España",
  ENG: "Inglaterra",     POR: "Portugal",       NED: "Países Bajos",
  BEL: "Bélgica",        ITA: "Italia",         SUI: "Suiza",
  // UEFA p2
  CRO: "Croacia",        AUT: "Austria",        DEN: "Dinamarca",
  SCO: "Escocia",        POL: "Polonia",        SRB: "Serbia",
  TUR: "Turquía",        ALB: "Albania",        HUN: "Hungría",        CZE: "Rep. Checa",
  // CAF
  MAR: "Marruecos",      SEN: "Senegal",        NGA: "Nigeria",
  CMR: "Camerún",        EGY: "Egipto",         GHA: "Ghana",
  CIV: "C. Marfil",      MLI: "Malí",           RSA: "Sudáfrica",
  // AFC
  JPN: "Japón",          KOR: "Corea del Sur",  IRN: "Irán",
  AUS: "Australia",      KSA: "Arabia Saudita", JOR: "Jordania",
  IRQ: "Irak",           UZB: "Uzbekistán",
  // CONCACAF
  USA: "EE.UU.",         CAN: "Canadá",         MEX: "México",
  PAN: "Panamá",         JAM: "Jamaica",        CRC: "Costa Rica",
  // OFC
  NZL: "Nueva Zelanda",
};

const CONF_OF: Record<string, string> = {
  ARG: "conmebol", BRA: "conmebol", COL: "conmebol", URU: "conmebol",
  ECU: "conmebol", VEN: "conmebol", PAR: "conmebol",
  GER: "uefa",     FRA: "uefa",     ESP: "uefa",     ENG: "uefa",
  POR: "uefa",     NED: "uefa",     BEL: "uefa",     ITA: "uefa",     SUI: "uefa",
  CRO: "uefa2",    AUT: "uefa2",    DEN: "uefa2",    SCO: "uefa2",    POL: "uefa2",
  SRB: "uefa2",    TUR: "uefa2",    ALB: "uefa2",    HUN: "uefa2",    CZE: "uefa2",
  MAR: "caf",      SEN: "caf",      NGA: "caf",      CMR: "caf",      EGY: "caf",
  GHA: "caf",      CIV: "caf",      MLI: "caf",      RSA: "caf",
  JPN: "afc",      KOR: "afc",      IRN: "afc",      AUS: "afc",
  KSA: "afc",      JOR: "afc",      IRQ: "afc",      UZB: "afc",
  USA: "concacaf", CAN: "concacaf", MEX: "concacaf", PAN: "concacaf",
  JAM: "concacaf", CRC: "concacaf",
  NZL: "ofc",
};

function buildPaniniMenu(note?: string): MenuPayload {
  return {
    text: `🃏 <b>Álbum Mundial 2026</b>${note ? `\n${note}` : ""}\n¿Confederación?`,
    keyboard: {
      inline_keyboard: [
        [
          { text: "🌎 CONMEBOL", callback_data: "j:panini:c:conmebol" },
          { text: "🏴󠁧󠁢󠁳󠁣󠁴󠁿 UEFA",     callback_data: "j:panini:c:uefa"    },
          { text: "🌍 CAF",      callback_data: "j:panini:c:caf"     },
        ],
        [
          { text: "🌏 AFC",      callback_data: "j:panini:c:afc"      },
          { text: "🗽 CONCACAF", callback_data: "j:panini:c:concacaf" },
          { text: "🌊 OFC",      callback_data: "j:panini:c:ofc"      },
        ],
        [{ text: "← Menú", callback_data: "j:menu" }],
      ],
    },
  };
}

function buildPaniniConmebol(): MenuPayload {
  return {
    text: "🃏 <b>CONMEBOL</b> — ¿qué país?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "ARG", callback_data: "j:panini:p:ARG" },
          { text: "BRA", callback_data: "j:panini:p:BRA" },
          { text: "COL", callback_data: "j:panini:p:COL" },
        ],
        [
          { text: "URU", callback_data: "j:panini:p:URU" },
          { text: "ECU", callback_data: "j:panini:p:ECU" },
          { text: "VEN", callback_data: "j:panini:p:VEN" },
        ],
        [
          { text: "PAR",     callback_data: "j:panini:p:PAR" },
          { text: "← Confs", callback_data: "j:panini"       },
        ],
      ],
    },
  };
}

function buildPaniniUefa1(): MenuPayload {
  return {
    text: "🃏 <b>UEFA</b> — ¿qué país? (1/2)",
    keyboard: {
      inline_keyboard: [
        [
          { text: "GER", callback_data: "j:panini:p:GER" },
          { text: "FRA", callback_data: "j:panini:p:FRA" },
          { text: "ESP", callback_data: "j:panini:p:ESP" },
        ],
        [
          { text: "ENG", callback_data: "j:panini:p:ENG" },
          { text: "POR", callback_data: "j:panini:p:POR" },
          { text: "NED", callback_data: "j:panini:p:NED" },
        ],
        [
          { text: "BEL", callback_data: "j:panini:p:BEL" },
          { text: "ITA", callback_data: "j:panini:p:ITA" },
          { text: "SUI", callback_data: "j:panini:p:SUI" },
        ],
        [
          { text: "→ Más (2/2)", callback_data: "j:panini:c:uefa2" },
          { text: "← Confs",    callback_data: "j:panini"          },
        ],
      ],
    },
  };
}

function buildPaniniUefa2(): MenuPayload {
  return {
    text: "🃏 <b>UEFA</b> — ¿qué país? (2/2)",
    keyboard: {
      inline_keyboard: [
        [
          { text: "CRO", callback_data: "j:panini:p:CRO" },
          { text: "AUT", callback_data: "j:panini:p:AUT" },
          { text: "DEN", callback_data: "j:panini:p:DEN" },
        ],
        [
          { text: "SCO", callback_data: "j:panini:p:SCO" },
          { text: "POL", callback_data: "j:panini:p:POL" },
          { text: "SRB", callback_data: "j:panini:p:SRB" },
        ],
        [
          { text: "TUR", callback_data: "j:panini:p:TUR" },
          { text: "ALB", callback_data: "j:panini:p:ALB" },
          { text: "HUN", callback_data: "j:panini:p:HUN" },
        ],
        [
          { text: "CZE",        callback_data: "j:panini:p:CZE"  },
          { text: "← UEFA 1/2", callback_data: "j:panini:c:uefa" },
          { text: "← Confs",    callback_data: "j:panini"        },
        ],
      ],
    },
  };
}

function buildPaniniCaf(): MenuPayload {
  return {
    text: "🃏 <b>CAF</b> — ¿qué país?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "MAR", callback_data: "j:panini:p:MAR" },
          { text: "SEN", callback_data: "j:panini:p:SEN" },
          { text: "NGA", callback_data: "j:panini:p:NGA" },
        ],
        [
          { text: "CMR", callback_data: "j:panini:p:CMR" },
          { text: "EGY", callback_data: "j:panini:p:EGY" },
          { text: "GHA", callback_data: "j:panini:p:GHA" },
        ],
        [
          { text: "CIV", callback_data: "j:panini:p:CIV" },
          { text: "MLI", callback_data: "j:panini:p:MLI" },
          { text: "RSA", callback_data: "j:panini:p:RSA" },
        ],
        [{ text: "← Confs", callback_data: "j:panini" }],
      ],
    },
  };
}

function buildPaniniAfc(): MenuPayload {
  return {
    text: "🃏 <b>AFC</b> — ¿qué país?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "JPN", callback_data: "j:panini:p:JPN" },
          { text: "KOR", callback_data: "j:panini:p:KOR" },
          { text: "IRN", callback_data: "j:panini:p:IRN" },
        ],
        [
          { text: "AUS", callback_data: "j:panini:p:AUS" },
          { text: "KSA", callback_data: "j:panini:p:KSA" },
          { text: "JOR", callback_data: "j:panini:p:JOR" },
        ],
        [
          { text: "IRQ",     callback_data: "j:panini:p:IRQ" },
          { text: "UZB",     callback_data: "j:panini:p:UZB" },
          { text: "← Confs", callback_data: "j:panini"       },
        ],
      ],
    },
  };
}

function buildPaniniConcacaf(): MenuPayload {
  return {
    text: "🃏 <b>CONCACAF</b> — ¿qué país?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "USA", callback_data: "j:panini:p:USA" },
          { text: "CAN", callback_data: "j:panini:p:CAN" },
          { text: "MEX", callback_data: "j:panini:p:MEX" },
        ],
        [
          { text: "PAN", callback_data: "j:panini:p:PAN" },
          { text: "JAM", callback_data: "j:panini:p:JAM" },
          { text: "CRC", callback_data: "j:panini:p:CRC" },
        ],
        [{ text: "← Confs", callback_data: "j:panini" }],
      ],
    },
  };
}

function buildPaniniOfc(): MenuPayload {
  return {
    text: "🃏 <b>OFC</b> — ¿qué país?",
    keyboard: {
      inline_keyboard: [
        [
          { text: "NZL",     callback_data: "j:panini:p:NZL" },
          { text: "← Confs", callback_data: "j:panini"       },
        ],
      ],
    },
  };
}

function buildPaniniNumbers(code: string): MenuPayload {
  const name = PANINI_NAMES[code] ?? code;
  const conf = CONF_OF[code] ?? "conmebol";
  const backConf = `j:panini:c:${conf}`;
  const n = (i: number) => ({ text: String(i), callback_data: `j:panini:n:${code}:${i}` });
  return {
    text: `🃏 <b>${name}</b> (${code}) — N° (1–9)`,
    keyboard: {
      inline_keyboard: [
        [n(1), n(2), n(3)],
        [n(4), n(5), n(6)],
        [n(7), n(8), n(9)],
        [
          { text: "→ 10-20",  callback_data: `j:panini:p2:${code}` },
          { text: "← Países", callback_data: backConf              },
        ],
      ],
    },
  };
}

function buildPaniniNumbers2(code: string): MenuPayload {
  const name = PANINI_NAMES[code] ?? code;
  const n = (i: number) => ({ text: String(i), callback_data: `j:panini:n:${code}:${i}` });
  return {
    text: `🃏 <b>${name}</b> (${code}) — N° (10–20)`,
    keyboard: {
      inline_keyboard: [
        [n(10), n(11), n(12)],
        [n(13), n(14), n(15)],
        [n(16), n(17), n(18)],
        [n(19), n(20), { text: "← 1–9", callback_data: `j:panini:p:${code}` }],
      ],
    },
  };
}

async function handlePaniniCallback(
  data: string,
  token: string,
  chatId: number,
  messageId: number,
): Promise<void> {
  // Confederation picker
  if (data === "j:panini") {
    const menu = buildPaniniMenu();
    await editMessage(token, chatId, messageId, menu.text, "HTML", menu.keyboard);
    return;
  }

  // Country picker
  if (data.startsWith("j:panini:c:")) {
    const conf = data.slice("j:panini:c:".length);
    let menu: MenuPayload;
    switch (conf) {
      case "conmebol": menu = buildPaniniConmebol(); break;
      case "uefa":     menu = buildPaniniUefa1();    break;
      case "uefa2":    menu = buildPaniniUefa2();    break;
      case "caf":      menu = buildPaniniCaf();      break;
      case "afc":      menu = buildPaniniAfc();      break;
      case "concacaf": menu = buildPaniniConcacaf(); break;
      case "ofc":      menu = buildPaniniOfc();      break;
      default: return;
    }
    await editMessage(token, chatId, messageId, menu.text, "HTML", menu.keyboard);
    return;
  }

  // Number picker page 1: j:panini:p:{CODE}
  const p1 = data.match(/^j:panini:p:([A-Z]{2,3})$/);
  if (p1) {
    const menu = buildPaniniNumbers(p1[1]);
    await editMessage(token, chatId, messageId, menu.text, "HTML", menu.keyboard);
    return;
  }

  // Number picker page 2: j:panini:p2:{CODE}
  const p2 = data.match(/^j:panini:p2:([A-Z]{2,3})$/);
  if (p2) {
    const menu = buildPaniniNumbers2(p2[1]);
    await editMessage(token, chatId, messageId, menu.text, "HTML", menu.keyboard);
    return;
  }

  // Generate code: j:panini:n:{CODE}:{num}
  const nMatch = data.match(/^j:panini:n:([A-Z]{2,3}):(\d+)$/);
  if (nMatch) {
    const code = nMatch[1];
    const num  = nMatch[2];
    const name = PANINI_NAMES[code] ?? code;
    const stickerCode = `${code}-${num}`;

    // Send code as new chat message (visible + copyable)
    await sendMessage(token, {
      chatId,
      text: `${name} · ${code} · <code>${stickerCode}</code>`,
      parseMode: "HTML",
    });

    // Reset picker to confederation view, ready for next sticker
    const menu = buildPaniniMenu(`✅ <code>${stickerCode}</code>`);
    await editMessage(token, chatId, messageId, menu.text, "HTML", menu.keyboard);
    return;
  }
}

// ---------------------------------------------------------------------------
// Mapeo acción → texto natural para el LLM
// ---------------------------------------------------------------------------

const ACTION_TEXT: Record<string, string> = {
  "j:brief:bo": "Genera el briefing para Bolivia",
  "j:brief:pe": "Genera el briefing para Perú",
  "j:brief:co": "Genera el briefing para Colombia",
  "j:tasks:personal": "Muéstrame mis tareas personales",
  "j:tasks:vibe": "Muéstrame los Vibe Projects",
  "j:tasks:new": "Quiero agregar una nueva tarea",
  "j:cal:today": "¿Qué tengo en el calendario hoy?",
  "j:cal:week": "¿Qué tengo esta semana en el calendario?",
  "j:cal:outlook": "¿Qué reuniones tengo en Outlook?",
  "j:cal:new": "Quiero crear un nuevo evento en el calendario",
  "j:health:sum": "Dame un resumen de mi salud",
  "j:health:trend": "Muéstrame la tendencia de mi salud",
  "j:health:work": "Muéstrame mis workouts recientes",
  "j:fx:bcb": "¿Cuál es el tipo de cambio BCB oficial hoy?",
  "j:fx:p2p": "¿Cuál es la tasa P2P de Binance ahora?",
  "j:fx:all": "Dame el tipo de cambio BCB oficial y P2P Binance",
  "j:fuel": "Muéstrame las gasolineras con combustible disponible en Santa Cruz",
  "j:tokens": "¿Cuánto presupuesto de Claude Max llevo hoy?",
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
const NAV_MENUS: Record<string, () => MenuPayload> = {
  "j:menu": buildMainMenu,
  "j:brief": buildBriefingMenu,
  "j:tasks": buildTasksMenu,
  "j:cal": buildAgendaMenu,
  "j:health": buildHealthMenu,
  "j:fx": buildCambioMenu,
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
): Promise<void> {
  const data = cb.data ?? "";
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;

  // Siempre dismissar el spinner de Telegram
  await answerCallbackQuery(token, cb.id);

  // --- Álbum Panini (mecánico, sin LLM) ---
  if (data === "j:panini" || data.startsWith("j:panini:")) {
    if (chatId == null || messageId == null) return;
    await handlePaniniCallback(data, token, chatId, messageId);
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
