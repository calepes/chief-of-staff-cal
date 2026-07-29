// task-types.ts — tipos compartidos del pipeline de mails "(Tarea)".
// Separado de task-check.ts para que task-card.ts / task-callbacks.ts (puros o casi) no tengan
// que importar el módulo que hace red y toca disco.

export interface TaskAttachmentMeta {
  filename: string;
  mimeType: string;
  attachmentId: string;
}

/** Propuesta viva: lo que la tarjeta muestra y Cal ajusta ANTES de que exista nada en Notion. */
export interface TaskProposal {
  messageId: string;
  threadId: string;
  subject: string;
  /** Asunto ya sin el tag "(Tarea)" — es el título que va a la página. */
  title: string;
  from: string;
  to: string;
  fechaRecepcion: string;
  resumen: string;
  accionRequerida: string;
  contextoRelevante: string | null;
  sinAccionClara: boolean;
  asignadoId: string;
  asignadoNombre: string;
  fecha: string | null;
  deadline: string | null;
  attachments: TaskAttachmentMeta[];
  /** Mails posteriores del MISMO thread llegados mientras la propuesta seguía pendiente: se
   * apendan como seguimiento después de crear la página, nunca abren una segunda propuesta. */
  followupIds: string[];
}

/** Entrada de la cola: liviana a propósito. El cuerpo del mail, los adjuntos y la síntesis con
 * Sonnet se resuelven recién cuando el ítem llega al frente — así un tick con 5 mails no dispara
 * 5 llamadas al modelo de golpe ni deja cuerpos de correo escritos en disco. */
export interface TaskQueueItem {
  messageId: string;
  threadId: string;
  subject: string;
  followupIds: string[];
  /** Propuesta ya sintetizada que quedó en KV porque falló el envío de su tarjeta. El reintento la
   * reusa en vez de volver a pagar Gmail + Sonnet: con Telegram caído (el SNI filtering dura lo
   * que dura la red) el cron corre cada 15 min y quemaría 4 turnos de Sonnet por hora sobre el
   * mismo correo, contra la cuota de Claude Max de Cal. */
  proposalId?: string;
}

/** Campo que la tarjeta está esperando por texto libre (botón ✍️). */
export type TaskInputField = "asignado" | "fecha" | "deadline";

export interface TaskPendingInput {
  proposalId: string;
  field: TaskInputField;
  /** message_id de la tarjeta que hizo la pregunta — se le quita el teclado al resolver (B5 del
   * skill telegram-bot-ux: la respuesta nace en una tarjeta NUEVA debajo del texto de Cal). */
  anchorMessageId: number;
}
