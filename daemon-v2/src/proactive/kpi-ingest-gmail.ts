export interface GmailCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

let tokenCache: { token: string; expiresAt: number } | null = null;

export async function gmailAccessToken(creds: GmailCreds, fetchFn: typeof fetch = fetch): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`gmail token ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const d = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!d.access_token) throw new Error("gmail token: sin access_token en la respuesta");

  tokenCache = { token: d.access_token, expiresAt: Date.now() + ((d.expires_in ?? 3600) - 60) * 1000 };
  return d.access_token;
}

export function resetGmailTokenCache(): void {
  tokenCache = null;
}

const SEARCH_QUERY =
  "to:carlos@lepesqueur.net from:clepesqueur@bcp.com.bo subject:Self-Service has:attachment newer_than:3d";

const SEGUIMIENTO_SEARCH_QUERY =
  'to:carlos@lepesqueur.net from:clepesqueur@bcp.com.bo subject:"Seguimiento Diario Yape Bolivia" has:attachment newer_than:3d';

const LENDING_SEARCH_QUERY =
  'to:carlos@lepesqueur.net from:clepesqueur@bcp.com.bo subject:"Reporte diario Créditos Yape Lending" has:attachment newer_than:3d';

// Sin has:attachment — a diferencia de los reportes de KPIs, un mail marcado (DN) por Cal puede
// no traer ningún adjunto (el contenido relevante está en el cuerpo).
const DAILY_NOTE_SEARCH_QUERY = 'to:carlos@lepesqueur.net from:clepesqueur@bcp.com.bo subject:"(DN)" newer_than:3d';

// Igual criterio que DAILY_NOTE_SEARCH_QUERY (sin has:attachment) — un mail marcado (Tarea) por
// Cal puede no traer ningún adjunto, el pedido está en el cuerpo del mail.
const TASK_SEARCH_QUERY = 'to:carlos@lepesqueur.net from:clepesqueur@bcp.com.bo subject:"(Tarea)" newer_than:3d';

export interface GmailMessageRef {
  id: string;
}

async function searchEmails(
  query: string,
  accessToken: string,
  fetchFn: typeof fetch,
): Promise<GmailMessageRef[]> {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q", query);
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`gmail search ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const d = (await res.json()) as { messages?: Array<{ id: string }> };
  return (d.messages ?? []).map((m) => ({ id: m.id }));
}

export async function searchSelfServiceEmails(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<GmailMessageRef[]> {
  return searchEmails(SEARCH_QUERY, accessToken, fetchFn);
}

export async function searchSeguimientoDiarioEmails(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<GmailMessageRef[]> {
  return searchEmails(SEGUIMIENTO_SEARCH_QUERY, accessToken, fetchFn);
}

export async function searchLendingReportEmails(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<GmailMessageRef[]> {
  return searchEmails(LENDING_SEARCH_QUERY, accessToken, fetchFn);
}

export async function searchDailyNoteEmails(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<GmailMessageRef[]> {
  return searchEmails(DAILY_NOTE_SEARCH_QUERY, accessToken, fetchFn);
}

export async function searchTaskEmails(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<GmailMessageRef[]> {
  return searchEmails(TASK_SEARCH_QUERY, accessToken, fetchFn);
}

export interface GmailAttachmentPart {
  filename: string;
  mimeType: string;
  attachmentId: string;
}

export interface GmailMessageDetail {
  id: string;
  internalDate: number;
  attachments: GmailAttachmentPart[];
  /** Opcionales — no rompen los mocks de los pipelines existentes que no los necesitan. */
  bodyText?: string | null;
  /** HTML crudo del body (sin strip) — para conversiones que necesitan preservar links/formato. */
  bodyHtml?: string | null;
  subject?: string | null;
  /** ID del hilo de Gmail (agrupa reenvíos/respuestas del mismo thread) — usado por el pipeline
   * de Tareas para anti-duplicados y para armar el link permalink al mail. */
  threadId?: string;
}

interface GmailPart {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string; data?: string };
  parts?: GmailPart[];
  headers?: Array<{ name: string; value: string }>;
}

export function extractHeader(headers: Array<{ name: string; value: string }> | undefined, name: string): string | null {
  const h = headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

function collectAttachments(part: GmailPart, out: GmailAttachmentPart[]): void {
  if (part.filename && part.body?.attachmentId) {
    out.push({ filename: part.filename, mimeType: part.mimeType ?? "", attachmentId: part.body.attachmentId });
  }
  for (const p of part.parts ?? []) collectAttachments(p, out);
}

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Extrae texto plano del body de un mensaje (DFS sobre `parts`, sin atarse a un solo pipeline
 * de KPIs) — prioriza `text/plain`; si el mensaje solo trae `text/html`, hace un strip mínimo de
 * tags. `null` si no encuentra ninguna parte de texto (ej. mensaje solo con adjuntos). */
export function extractPlainTextBody(part: GmailPart): string | null {
  let plain: string | null = null;
  let html: string | null = null;

  function visit(p: GmailPart): void {
    if (p.mimeType === "text/plain" && p.body?.data && plain === null) {
      plain = decodeBase64Url(p.body.data);
    } else if (p.mimeType === "text/html" && p.body?.data && html === null) {
      html = decodeBase64Url(p.body.data);
    }
    for (const child of p.parts ?? []) visit(child);
  }
  visit(part);

  if (plain !== null) return plain;
  if (html !== null) return stripHtml(html);
  return null;
}

/** Igual DFS que extractPlainTextBody, pero devuelve el HTML CRUDO (sin strip) si existe —
 * lo necesita cualquier conversión que quiera preservar links/formato (ej. a Markdown) en vez
 * de perderlos con el strip mínimo de stripHtml(). `null` si el mensaje no trae text/html. */
export function extractHtmlBody(part: GmailPart): string | null {
  let html: string | null = null;
  function visit(p: GmailPart): void {
    if (p.mimeType === "text/html" && p.body?.data && html === null) {
      html = decodeBase64Url(p.body.data);
    }
    for (const child of p.parts ?? []) visit(child);
  }
  visit(part);
  return html;
}

export async function getGmailMessage(
  messageId: string,
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<GmailMessageDetail> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`;
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok)
    throw new Error(`gmail get message ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const d = (await res.json()) as { id: string; internalDate: string; payload: GmailPart; threadId?: string };
  const attachments: GmailAttachmentPart[] = [];
  collectAttachments(d.payload, attachments);
  return {
    id: d.id,
    internalDate: Number(d.internalDate),
    attachments,
    bodyText: extractPlainTextBody(d.payload),
    bodyHtml: extractHtmlBody(d.payload),
    subject: extractHeader(d.payload.headers, "Subject"),
    threadId: d.threadId,
  };
}

export function findCsvCandidates(attachments: GmailAttachmentPart[]): GmailAttachmentPart[] {
  return attachments.filter((a) => a.filename.toLowerCase().endsWith(".csv"));
}

export function findPdfCandidates(attachments: GmailAttachmentPart[]): GmailAttachmentPart[] {
  return attachments.filter((a) => a.filename.toLowerCase().endsWith(".pdf"));
}

async function fetchAttachmentBytes(
  messageId: string,
  attachmentId: string,
  accessToken: string,
  fetchFn: typeof fetch,
): Promise<Buffer> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`;
  const res = await fetchFn(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok)
    throw new Error(`gmail get attachment ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const d = (await res.json()) as { data?: string };
  if (!d.data) throw new Error("gmail attachment: sin campo data en la respuesta");
  const b64 = d.data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

export async function downloadGmailAttachment(
  messageId: string,
  attachmentId: string,
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const buf = await fetchAttachmentBytes(messageId, attachmentId, accessToken, fetchFn);
  return buf.toString("utf8");
}

export async function downloadGmailAttachmentBuffer(
  messageId: string,
  attachmentId: string,
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<Buffer> {
  return fetchAttachmentBytes(messageId, attachmentId, accessToken, fetchFn);
}

/**
 * Archiva el hilo (quita INBOX) y lo marca leído (quita UNREAD). Requiere scope `gmail.modify` —
 * con un token de solo `gmail.readonly` esto falla con 403. Ver Jano/CLAUDE.md sección
 * "scheduleKpiIngestCheck" para el estado de esa migración de scope.
 */
export async function archiveAndMarkRead(
  messageId: string,
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ removeLabelIds: ["INBOX", "UNREAD"] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok)
    throw new Error(`gmail archive/markRead ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}
