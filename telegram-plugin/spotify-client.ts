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

function getWorkerUrl(): string {
  const env = loadEnv();
  return env.SPOTIFY_AUTH_WORKER_URL ?? '';
}

const SPOTIFY_API = 'https://api.spotify.com/v1';

async function getToken(): Promise<{ token?: string; error?: string }> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    return { error: 'SPOTIFY_AUTH_WORKER_URL not found in .env' };
  }

  try {
    const res = await fetch(`${workerUrl}/token`);
    if (!res.ok) {
      const text = await res.text();
      return { error: `Auth worker ${res.status}: ${text}` };
    }
    const data = await res.json() as { access_token?: string; token?: string };
    const token = data.access_token ?? data.token;
    if (!token) {
      return { error: 'No token in auth worker response' };
    }
    return { token };
  } catch (err) {
    return { error: String(err) };
  }
}

async function spotifyRequest(
  method: string,
  path: string
): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }> {
  const { token, error } = await getToken();
  if (!token) {
    return { ok: false, error };
  }

  try {
    const res = await fetch(`${SPOTIFY_API}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      return { ok: false, status: res.status, error: `Spotify API ${res.status}: ${text}` };
    }

    if (res.status === 204) {
      return { ok: true, status: 204 };
    }

    const data = await res.json();
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function play(): Promise<{ ok: boolean; error?: string }> {
  const result = await spotifyRequest('PUT', '/me/player/play');
  return { ok: result.ok, error: result.error };
}

export async function pause(): Promise<{ ok: boolean; error?: string }> {
  const result = await spotifyRequest('PUT', '/me/player/pause');
  return { ok: result.ok, error: result.error };
}

export async function skipNext(): Promise<{ ok: boolean; error?: string }> {
  const result = await spotifyRequest('POST', '/me/player/next');
  return { ok: result.ok, error: result.error };
}

export async function skipPrevious(): Promise<{ ok: boolean; error?: string }> {
  const result = await spotifyRequest('POST', '/me/player/previous');
  return { ok: result.ok, error: result.error };
}

export async function setVolume(percent: number): Promise<{ ok: boolean; error?: string }> {
  const clamped = Math.min(100, Math.max(0, Math.round(percent)));
  const result = await spotifyRequest('PUT', `/me/player/volume?volume_percent=${clamped}`);
  return { ok: result.ok, error: result.error };
}

export async function nowPlaying(): Promise<{
  ok: boolean;
  track?: string;
  artist?: string;
  error?: string;
}> {
  const result = await spotifyRequest('GET', '/me/player/currently-playing');

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  if (result.status === 204) {
    return { ok: true, track: 'Nothing playing' };
  }

  const data = result.data as {
    item?: {
      name?: string;
      artists?: { name: string }[];
    };
  };

  const track = data?.item?.name ?? 'Unknown track';
  const artist = data?.item?.artists?.map((a) => a.name).join(', ') ?? 'Unknown artist';

  return { ok: true, track, artist };
}
