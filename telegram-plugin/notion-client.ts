import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram');

function loadEnv(): Record<string, string> {
  try {
    const content = readFileSync(join(STATE_DIR, '.env'), 'utf-8');
    const result: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function toUUID(id: string): string {
  // Convert 32 hex chars to 8-4-4-4-12 UUID format
  const clean = id.replace(/-/g, '');
  if (clean.length !== 32) return id;
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
}

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function getToken(): string {
  const env = loadEnv();
  return env.NOTION_TOKEN ?? '';
}

async function patchPage(pageId: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const token = getToken();
  if (!token) {
    return { ok: false, error: 'NOTION_TOKEN not found in .env' };
  }

  const uuid = toUUID(pageId);
  const url = `${NOTION_API}/pages/${uuid}`;

  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Notion API ${res.status}: ${text}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function updateTaskStatus(
  pageId: string,
  status: string
): Promise<{ ok: boolean; error?: string }> {
  return patchPage(pageId, {
    properties: {
      Estado: {
        status: { name: status },
      },
    },
  });
}

export async function updateTaskDate(
  pageId: string,
  field: 'Fecha' | 'Deadline',
  date: string
): Promise<{ ok: boolean; error?: string }> {
  return patchPage(pageId, {
    properties: {
      [field]: {
        date: { start: date },
      },
    },
  });
}
