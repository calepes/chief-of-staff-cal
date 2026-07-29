// task-notion.ts — escritura a la DB Notion "Tareas" para el pipeline de mails (Tarea).
// Mismo patrón de fetch directo (sin SDK) que daily-note-ingest.ts / kpi-ingest-notion.ts.

export const TAREAS_DB_ID = "1f2c487609dd802985dcd7ad59110ddd";
export const CAL_PEOPLE_PAGE_ID = "2f2fc7e7523043b2b65c19d38f608de7";
export const CAL_NOTION_USER_ID = "11fa1824-6b4f-49b1-9427-8c2c494b69c1";

/** El tag lo agrega Cal a mano al reenviar un mail que quiere convertir en tarea — no hace falta
 * tolerar variantes raras, solo mayúscula/minúscula, igual criterio que hasDnTag. */
export function hasTareaTag(subject: string): boolean {
  return /\(tarea\)/i.test(subject);
}

/** Quita el tag (y espacios sobrantes alrededor) para usar el resto del asunto como título de la
 * tarea — nunca queda un "(Tarea) " residual en el título. */
export function stripTareaTag(subject: string): string {
  return subject.replace(/\(tarea\)\s*/gi, "").trim();
}

/** Permalink a Gmail por threadId — funciona tanto si el mail sigue en INBOX como si ya fue
 * archivado (a diferencia de un link "#inbox/{id}", que deja de resolver tras archivar). */
export function gmailPermalink(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${threadId}`;
}

interface RichTextItem {
  type: "text";
  text: { content: string; link?: { url: string } | null };
}

function plainRun(content: string): RichTextItem {
  return { type: "text", text: { content } };
}

function paragraph(text: string): Record<string, unknown> {
  return { object: "block", type: "paragraph", paragraph: { rich_text: [plainRun(text)] } };
}

function boldLabelParagraph(label: string, value: string): Record<string, unknown> {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        { type: "text", text: { content: `${label}: ` }, annotations: { bold: true } },
        plainRun(value),
      ],
    },
  };
}

function heading(text: string): Record<string, unknown> {
  return { object: "block", type: "heading_3", heading_3: { rich_text: [plainRun(text)] } };
}

function bulletedItem(text: string): Record<string, unknown> {
  return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [plainRun(text)] } };
}

export interface TaskAttachmentRef {
  filename: string;
  fileUploadId: string;
}

export interface BuildTaskBodyInput {
  from: string;
  to: string;
  subject: string;
  fechaRecepcion: string;
  resumen: string;
  accionRequerida: string;
  contextoRelevante: string | null;
  threadId: string;
  sinAccionClara: boolean;
  preguntas: string[];
  attachments: TaskAttachmentRef[];
}

/** Arma el body de la tarea siguiendo el spec de "Cron para Tareas en Notion": Origen del correo,
 * síntesis, link al mail (bookmark — la API pública no tiene un bloque nativo de Gmail), sección
 * de Preguntas si falta Fecha/Deadline, y los adjuntos reales al final. */
export function buildTaskBodyBlocks(input: BuildTaskBodyInput): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [
    heading("📧 Origen del correo"),
    boldLabelParagraph("De", input.from),
    boldLabelParagraph("Para", input.to),
    boldLabelParagraph("Asunto original", input.subject),
    boldLabelParagraph("Fecha de recepción", input.fechaRecepcion),
    { object: "block", type: "bookmark", bookmark: { url: gmailPermalink(input.threadId) } },
  ];

  if (input.sinAccionClara) {
    blocks.push(paragraph("⚠️ El correo no deja una acción concreta pedida — requiere revisión manual."));
  }

  blocks.push(heading("Resumen ejecutivo"), paragraph(input.resumen));
  blocks.push(heading("Acción requerida"), paragraph(input.accionRequerida));
  if (input.contextoRelevante) {
    blocks.push(heading("Contexto relevante"), paragraph(input.contextoRelevante));
  }

  if (input.preguntas.length > 0) {
    blocks.push(heading("❓ Preguntas"), ...input.preguntas.map((p) => bulletedItem(p)));
  }

  if (input.attachments.length > 0) {
    blocks.push(
      heading("📎 Adjuntos"),
      ...input.attachments.map((a) => ({
        object: "block",
        type: "file",
        file: { type: "file_upload", file_upload: { id: a.fileUploadId }, name: a.filename },
      })),
    );
  }

  return blocks;
}

async function notionRequest(notionToken: string, method: string, path: string, body: unknown, fetchFn: typeof fetch): Promise<any> {
  const res = await fetchFn(`https://api.notion.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`notion ${method} ${path} -> ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  return res.json();
}

const NOTION_CHILDREN_PER_CALL = 100;

async function appendChildrenInBatches(notionToken: string, pageId: string, blocks: Record<string, unknown>[], fetchFn: typeof fetch): Promise<void> {
  for (let i = 0; i < blocks.length; i += NOTION_CHILDREN_PER_CALL) {
    await notionRequest(notionToken, "PATCH", `/v1/blocks/${pageId}/children`, { children: blocks.slice(i, i + NOTION_CHILDREN_PER_CALL) }, fetchFn);
  }
}

export interface CreateTaskPageInput {
  /** Ya sin el tag "(Tarea)" — ver stripTareaTag(). */
  title: string;
  resumen: string;
  deadline: string | null;
  fecha: string | null;
  /** pageId de People en "Asignado a". Lo elige Cal en la tarjeta; default CAL (ver
   * task-people.ts). "Solicitado por" queda siempre en Cal: es él quien reenvía el mail. */
  asignadoId?: string;
  body: BuildTaskBodyInput;
}

export interface CreateTaskPageResult {
  pageId: string;
  url: string;
}

export async function createTaskPage(
  notionToken: string,
  input: CreateTaskPageInput,
  fetchFn: typeof fetch = fetch,
): Promise<CreateTaskPageResult> {
  const blocks = buildTaskBodyBlocks(input.body);
  const firstBatch = blocks.slice(0, NOTION_CHILDREN_PER_CALL);
  const rest = blocks.slice(NOTION_CHILDREN_PER_CALL);

  const properties: Record<string, unknown> = {
    "Nombre de tarea": { title: [{ text: { content: input.title } }] },
    Estado: { status: { name: "Sin empezar" } },
    "Asignado a": { relation: [{ id: input.asignadoId ?? CAL_PEOPLE_PAGE_ID }] },
    "Solicitado por": { relation: [{ id: CAL_PEOPLE_PAGE_ID }] },
    Resumen: { rich_text: [{ text: { content: input.resumen } }] },
  };
  if (input.deadline) properties["Deadline"] = { date: { start: input.deadline } };
  if (input.fecha) properties["Fecha"] = { date: { start: input.fecha } };

  const page = await notionRequest(
    notionToken,
    "POST",
    "/v1/pages",
    { parent: { database_id: TAREAS_DB_ID }, properties, children: firstBatch },
    fetchFn,
  );

  // El resto de los bloques (más de 100) va en llamadas aparte, y su fallo NO puede tirar la
  // creación: la página YA existe en Notion, así que propagar el error dejaría al caller creyendo
  // que no se creó nada — y su reintento generaría una segunda página. Se loguea y se sigue.
  try {
    await appendChildrenInBatches(notionToken, page.id, rest, fetchFn);
  } catch (err) {
    console.error(
      JSON.stringify({ ts: Date.now(), msg: "task_body_append_failed", pageId: page.id, err: String(err) }),
    );
  }

  return { pageId: page.id, url: page.url };
}

/** Mail nuevo detectado en un thread que ya tiene tarea creada (dedup por threadId, ver
 * task-check.ts) — spec: "actualizar la tarea existente solo si el correo agrega contexto
 * relevante". Se agrega como bloque de seguimiento, nunca se pisa el contenido original. */
export async function appendTaskFollowup(
  notionToken: string,
  pageId: string,
  input: { fechaRecepcion: string; resumen: string },
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await appendChildrenInBatches(
    notionToken,
    pageId,
    [heading(`↪️ Seguimiento (${input.fechaRecepcion})`), paragraph(input.resumen)],
    fetchFn,
  );
}

/** @mention real a Cal en un comentario de la página — es lo único que dispara notificación push
 * de Notion vía API pública (no hay bloque nativo de "notificar a X"). Requiere que la
 * integración tenga capacidad de insertar comentarios habilitada (Developer portal) — si no,
 * falla con 403 y el caller debe tragarlo (mismo criterio que archiveAndMarkRead: el resto del
 * flujo no depende de esto, Cal igual se entera por el reporte de Telegram). */
export async function notifyMissingDate(notionToken: string, pageId: string, mensaje: string, fetchFn: typeof fetch = fetch): Promise<void> {
  await notionRequest(
    notionToken,
    "POST",
    "/v1/comments",
    {
      parent: { page_id: pageId },
      rich_text: [
        { type: "mention", mention: { type: "user", user: { id: CAL_NOTION_USER_ID } } },
        plainRun(` ${mensaje}`),
      ],
    },
    fetchFn,
  );
}

interface FileUploadCreateResult {
  id: string;
  upload_url: string;
}

/** Sube un adjunto del mail a Notion (flujo público de 2 pasos: crear + mandar bytes) y devuelve
 * el file_upload id para referenciar en un bloque `file` (ver buildTaskBodyBlocks). */
export async function uploadAttachmentToNotion(
  notionToken: string,
  attachment: { filename: string; mimeType: string; bytes: Buffer },
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const created = (await notionRequest(
    notionToken,
    "POST",
    "/v1/file_uploads",
    { filename: attachment.filename, content_type: attachment.mimeType || undefined },
    fetchFn,
  )) as FileUploadCreateResult;

  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(attachment.bytes)], { type: attachment.mimeType || undefined }), attachment.filename);

  const sendRes = await fetchFn(`https://api.notion.com/v1/file_uploads/${created.id}/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${notionToken}`, "Notion-Version": "2022-06-28" },
    body: fd,
    signal: AbortSignal.timeout(30_000),
  });
  if (!sendRes.ok) throw new Error(`notion file_uploads send -> ${sendRes.status}: ${(await sendRes.text().catch(() => "")).slice(0, 300)}`);

  return created.id;
}
