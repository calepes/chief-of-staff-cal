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

export interface GmailAttachmentPart {
  filename: string;
  mimeType: string;
  attachmentId: string;
}

export interface GmailMessageDetail {
  id: string;
  internalDate: number;
  attachments: GmailAttachmentPart[];
}

interface GmailPart {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string };
  parts?: GmailPart[];
}

function collectAttachments(part: GmailPart, out: GmailAttachmentPart[]): void {
  if (part.filename && part.body?.attachmentId) {
    out.push({ filename: part.filename, mimeType: part.mimeType ?? "", attachmentId: part.body.attachmentId });
  }
  for (const p of part.parts ?? []) collectAttachments(p, out);
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
  const d = (await res.json()) as { id: string; internalDate: string; payload: GmailPart };
  const attachments: GmailAttachmentPart[] = [];
  collectAttachments(d.payload, attachments);
  return { id: d.id, internalDate: Number(d.internalDate), attachments };
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
