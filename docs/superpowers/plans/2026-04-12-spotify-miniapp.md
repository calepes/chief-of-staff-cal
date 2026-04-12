# Spotify Mini App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Telegram Web App (TWA) for Spotify with a full player, search, and queue — served from a Cloudflare Worker with Dark Glass aesthetic.

**Architecture:** Single Cloudflare Worker serves the HTML app at `/` and proxies Spotify API calls through `/api/*` routes. Tokens come from the existing `spotify-auth` worker's `/token` endpoint. No state, no KV, no D1.

**Tech Stack:** Cloudflare Workers (Wrangler), TypeScript, vanilla HTML/CSS/JS (inline), Spotify Web API, Telegram WebApp SDK.

**Spec:** `docs/superpowers/specs/2026-04-12-spotify-miniapp-design.md`

---

## File Structure

```
spotify-miniapp-worker/
├── wrangler.toml              — Worker config (name, vars)
├── package.json               — Scripts: dev, deploy
├── src/
│   ├── index.ts               — Worker entry: route GET / and /api/*
│   ├── spotify.ts             — getToken() + spotifyFetch() helper
│   ├── api.ts                 — All /api/* route handlers
│   └── app.ts                 — HTML string export (the full mini app)
```

All frontend code lives in `app.ts` as a single exported HTML string. No build step, no asset pipeline.

---

## Task 1: Project scaffold + Worker skeleton

**Files:**
- Create: `spotify-miniapp-worker/wrangler.toml`
- Create: `spotify-miniapp-worker/package.json`
- Create: `spotify-miniapp-worker/src/index.ts`

- [ ] **Step 1: Create project directory**

```bash
mkdir -p spotify-miniapp-worker/src
```

- [ ] **Step 2: Create wrangler.toml**

```toml
name = "spotify-miniapp"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
SPOTIFY_AUTH_WORKER = "https://spotify-auth.carlos-cb4.workers.dev"
```

- [ ] **Step 3: Create package.json**

```json
{
  "name": "spotify-miniapp-worker",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^4.81.1"
  }
}
```

- [ ] **Step 4: Create minimal index.ts**

```typescript
export interface Env {
  SPOTIFY_AUTH_WORKER: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      return new Response('Spotify Mini App — placeholder', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
```

- [ ] **Step 5: Install dependencies and test locally**

```bash
cd spotify-miniapp-worker && npm install && npx wrangler dev
```

Open `http://localhost:8787/` — should show "Spotify Mini App — placeholder".
Open `http://localhost:8787/api/test` — should return `{"status":"ok"}`.

Stop the dev server with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add spotify-miniapp-worker/
git commit -m "feat: scaffold spotify-miniapp worker project"
```

---

## Task 2: Spotify API proxy (spotify.ts + api.ts)

**Files:**
- Create: `spotify-miniapp-worker/src/spotify.ts`
- Create: `spotify-miniapp-worker/src/api.ts`
- Modify: `spotify-miniapp-worker/src/index.ts`

- [ ] **Step 1: Create spotify.ts — token fetcher + request helper**

```typescript
// Token cache: avoid hitting auth worker on every request.
// Spotify tokens last 60min; we cache for 50min.
let cachedToken: string | null = null;
let tokenExpiresAt = 0;
const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 minutes

export async function getToken(authWorkerUrl: string): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const res = await fetch(`${authWorkerUrl}/token`);
  if (!res.ok) {
    throw new Error(`Auth worker error: ${res.status}`);
  }
  const data = (await res.json()) as { access_token: string };
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
  return cachedToken;
}

const SPOTIFY_API = 'https://api.spotify.com/v1';

export async function spotifyFetch(
  authWorkerUrl: string,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const token = await getToken(authWorkerUrl);

  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(`${SPOTIFY_API}${path}`, init);

  // If 401, token may be stale — clear cache and retry once
  if (res.status === 401) {
    cachedToken = null;
    tokenExpiresAt = 0;
    const freshToken = await getToken(authWorkerUrl);
    const retryInit: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${freshToken}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) retryInit.body = JSON.stringify(body);
    const retryRes = await fetch(`${SPOTIFY_API}${path}`, retryInit);
    const retryText = await retryRes.text();
    return new Response(retryText || null, {
      status: retryRes.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // Pass through Spotify's response (status, body)
  const text = await res.text();
  return new Response(text || null, {
    status: res.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
```

- [ ] **Step 2: Create api.ts — all API route handlers**

```typescript
import { spotifyFetch } from './spotify';

export async function handleApi(
  request: Request,
  url: URL,
  authWorkerUrl: string
): Promise<Response> {
  const path = url.pathname.replace('/api', '');
  const cors = { 'Access-Control-Allow-Origin': '*' };

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  switch (path) {
    case '/now-playing':
      return spotifyFetch(authWorkerUrl, 'GET', '/me/player/currently-playing');

    case '/play':
      return spotifyFetch(authWorkerUrl, 'PUT', '/me/player/play');

    case '/pause':
      return spotifyFetch(authWorkerUrl, 'PUT', '/me/player/pause');

    case '/next':
      return spotifyFetch(authWorkerUrl, 'POST', '/me/player/next');

    case '/previous':
      return spotifyFetch(authWorkerUrl, 'POST', '/me/player/previous');

    case '/volume': {
      const percent = url.searchParams.get('percent') ?? '50';
      return spotifyFetch(
        authWorkerUrl,
        'PUT',
        `/me/player/volume?volume_percent=${encodeURIComponent(percent)}`
      );
    }

    case '/queue':
      return spotifyFetch(authWorkerUrl, 'GET', '/me/player/queue');

    case '/search': {
      const q = url.searchParams.get('q') ?? '';
      const type = url.searchParams.get('type') ?? 'track,artist,playlist';
      return spotifyFetch(
        authWorkerUrl,
        'GET',
        `/search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}&limit=10`
      );
    }

    case '/play-uri': {
      const body = (await request.json()) as {
        uri?: string;
        context_uri?: string;
        offset?: { uri?: string; position?: number };
      };
      const playBody: Record<string, unknown> = {};
      if (body.uri) playBody.uris = [body.uri];
      if (body.context_uri) playBody.context_uri = body.context_uri;
      if (body.offset) playBody.offset = body.offset;
      return spotifyFetch(authWorkerUrl, 'PUT', '/me/player/play', playBody);
    }

    default:
      return new Response(JSON.stringify({ error: 'Unknown API route' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
  }
}
```

- [ ] **Step 3: Update index.ts to wire the router**

Replace the full content of `index.ts`:

```typescript
import { handleApi } from './api';

export interface Env {
  SPOTIFY_AUTH_WORKER: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '') {
      return new Response('<!-- app placeholder -->', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, url, env.SPOTIFY_AUTH_WORKER);
    }

    return new Response('Not found', { status: 404 });
  },
};
```

- [ ] **Step 4: Test the API proxy locally**

```bash
cd spotify-miniapp-worker && npx wrangler dev
```

In another terminal:
```bash
curl http://localhost:8787/api/now-playing
```

Expected: JSON response from Spotify (track info or 204 empty if nothing playing).

```bash
curl http://localhost:8787/api/search?q=Bunbury&type=track
```

Expected: JSON with search results containing tracks by Bunbury.

Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add spotify-miniapp-worker/src/
git commit -m "feat: spotify API proxy routes (now-playing, play, pause, search, queue)"
```

---

## Task 3: Player UI — HTML/CSS shell

**Files:**
- Create: `spotify-miniapp-worker/src/app.ts`
- Modify: `spotify-miniapp-worker/src/index.ts`

- [ ] **Step 1: Create app.ts with the Dark Glass player layout**

```typescript
export function getAppHtml(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Spotify</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(135deg, #1a1a2e, #2d1b69);
    color: #fff;
    min-height: 100vh;
    overflow: hidden;
    transition: background 0.8s ease;
  }

  /* --- Dynamic background --- */
  #bg-gradient {
    position: fixed; inset: 0;
    background: linear-gradient(135deg, #1a1a2e, #2d1b69);
    transition: background 0.8s ease;
    z-index: 0;
  }
  #bg-blur {
    position: fixed; inset: 0;
    backdrop-filter: blur(60px); -webkit-backdrop-filter: blur(60px);
    z-index: 1;
  }

  /* --- Player --- */
  #player {
    position: relative; z-index: 2;
    display: flex; flex-direction: column; align-items: center;
    padding: 24px 20px 20px;
    min-height: 100vh;
    justify-content: space-between;
  }

  /* Album art */
  #album-art-container {
    width: min(280px, 65vw); height: min(280px, 65vw);
    border-radius: 16px;
    background: rgba(255,255,255,0.08);
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(255,255,255,0.12);
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    overflow: hidden;
    margin-top: 8px;
  }
  #album-art {
    width: 100%; height: 100%;
    object-fit: cover;
    border-radius: 16px;
  }
  #album-art-placeholder {
    width: 100%; height: 100%;
    display: flex; align-items: center; justify-content: center;
    font-size: 64px; color: rgba(255,255,255,0.2);
  }

  /* Track info */
  #track-info {
    text-align: center;
    margin: 16px 0 8px;
    width: 100%;
    padding: 0 12px;
  }
  #track-name {
    font-size: 18px; font-weight: 700;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #track-artist {
    font-size: 14px; color: #a0a0b0;
    margin-top: 4px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #track-album {
    font-size: 12px; color: #707080;
    margin-top: 2px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  /* Progress bar */
  #progress-container {
    width: 100%; padding: 0 12px;
    margin: 8px 0;
  }
  #progress-bar-bg {
    width: 100%; height: 4px;
    background: rgba(255,255,255,0.1);
    border-radius: 2px;
    cursor: pointer;
    position: relative;
  }
  #progress-bar-bg:hover { height: 6px; }
  #progress-bar {
    height: 100%; width: 0%;
    background: linear-gradient(90deg, #1DB954, #1ed760);
    border-radius: 2px;
    transition: width 0.3s linear;
  }
  #progress-times {
    display: flex; justify-content: space-between;
    font-size: 11px; color: #707080;
    margin-top: 4px;
  }

  /* Controls */
  #controls {
    display: flex; align-items: center; justify-content: center;
    gap: 24px;
    margin: 8px 0;
  }
  .ctrl-btn {
    background: rgba(255,255,255,0.1);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 50%;
    color: #fff;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.2s, transform 0.1s;
  }
  .ctrl-btn:active { transform: scale(0.92); }
  .ctrl-btn:hover { background: rgba(255,255,255,0.18); }
  .ctrl-sm { width: 40px; height: 40px; font-size: 16px; }
  .ctrl-md { width: 44px; height: 44px; font-size: 18px; }
  .ctrl-lg { width: 56px; height: 56px; font-size: 22px; }
  .ctrl-active { color: #1DB954; }

  /* Volume */
  #volume-container {
    width: 100%; padding: 0 40px;
    display: flex; align-items: center; gap: 10px;
  }
  #volume-slider {
    -webkit-appearance: none; appearance: none;
    flex: 1; height: 4px;
    background: rgba(255,255,255,0.1);
    border-radius: 2px; outline: none;
  }
  #volume-slider::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 14px; height: 14px;
    background: #fff; border-radius: 50%;
    cursor: pointer;
  }
  .vol-icon { font-size: 14px; color: #a0a0b0; }

  /* Nav bar */
  #nav-bar {
    display: flex; justify-content: center; gap: 32px;
    padding: 12px 0 8px;
  }
  .nav-btn {
    background: rgba(255,255,255,0.08);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 16px;
    color: #a0a0b0;
    padding: 10px 24px;
    font-size: 16px;
    cursor: pointer;
    transition: background 0.2s;
  }
  .nav-btn:hover { background: rgba(255,255,255,0.15); color: #fff; }

  /* --- Sheets (search, queue) --- */
  .sheet-overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.5);
    z-index: 10;
    opacity: 0; pointer-events: none;
    transition: opacity 0.3s;
  }
  .sheet-overlay.open { opacity: 1; pointer-events: auto; }

  .sheet {
    position: fixed; left: 0; right: 0; bottom: 0;
    height: 85vh;
    background: rgba(20,20,40,0.95);
    backdrop-filter: blur(40px); -webkit-backdrop-filter: blur(40px);
    border-top: 1px solid rgba(255,255,255,0.1);
    border-radius: 20px 20px 0 0;
    z-index: 11;
    transform: translateY(100%);
    transition: transform 0.35s cubic-bezier(0.32, 0.72, 0, 1);
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  .sheet.open { transform: translateY(0); }

  .sheet-handle {
    width: 36px; height: 4px;
    background: rgba(255,255,255,0.2);
    border-radius: 2px;
    margin: 10px auto 0;
    flex-shrink: 0;
  }
  .sheet-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 16px 20px 8px;
    flex-shrink: 0;
  }
  .sheet-title { font-size: 18px; font-weight: 700; }
  .sheet-close {
    background: rgba(255,255,255,0.1);
    border: none; border-radius: 50%;
    color: #fff; width: 30px; height: 30px;
    font-size: 16px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .sheet-body {
    flex: 1; overflow-y: auto;
    padding: 0 20px 20px;
    -webkit-overflow-scrolling: touch;
  }

  /* Search input */
  #search-input {
    width: 100%; padding: 12px 16px 12px 40px;
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px;
    color: #fff; font-size: 15px;
    outline: none;
    margin-bottom: 16px;
  }
  #search-input::placeholder { color: #707080; }
  #search-input-wrapper {
    position: relative; margin-bottom: 0;
  }
  #search-input-wrapper::before {
    content: '\\1F50D';
    position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
    font-size: 14px; pointer-events: none;
  }

  /* Result items */
  .result-section { margin-bottom: 20px; }
  .result-section-title {
    font-size: 13px; font-weight: 600; color: #a0a0b0;
    text-transform: uppercase; letter-spacing: 0.5px;
    margin-bottom: 10px;
  }
  .result-item {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 0;
    cursor: pointer;
    transition: background 0.15s;
    border-radius: 8px;
  }
  .result-item:active { background: rgba(255,255,255,0.05); }
  .result-img {
    width: 44px; height: 44px;
    border-radius: 6px;
    object-fit: cover;
    background: rgba(255,255,255,0.05);
    flex-shrink: 0;
  }
  .result-img.circle { border-radius: 50%; }
  .result-text { overflow: hidden; }
  .result-name {
    font-size: 14px; font-weight: 600;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .result-sub {
    font-size: 12px; color: #707080;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  /* Queue items */
  .queue-item {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid rgba(255,255,255,0.05);
  }
  .queue-item.now-playing {
    background: rgba(29,185,84,0.1);
    border: 1px solid rgba(29,185,84,0.2);
    border-radius: 10px;
    padding: 10px 12px;
    margin-bottom: 8px;
  }
  .queue-np-label {
    font-size: 11px; color: #1DB954; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px;
    margin-bottom: 8px;
  }

  /* Skeleton loading */
  .skeleton {
    background: linear-gradient(90deg,
      rgba(255,255,255,0.04) 25%,
      rgba(255,255,255,0.08) 50%,
      rgba(255,255,255,0.04) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.5s infinite;
    border-radius: 6px;
  }
  @keyframes shimmer { to { background-position: -200% 0; } }

  /* Empty state */
  .empty-state {
    text-align: center; color: #707080;
    padding: 40px 20px; font-size: 14px;
  }

  /* No device state */
  #no-device {
    display: none;
    text-align: center; color: #a0a0b0;
    padding: 20px; font-size: 14px;
  }
</style>
</head>
<body>

<div id="bg-gradient"></div>
<div id="bg-blur"></div>

<div id="player">
  <!-- Album Art -->
  <div id="album-art-container">
    <img id="album-art" style="display:none" crossorigin="anonymous">
    <div id="album-art-placeholder">🎵</div>
  </div>

  <!-- Track Info -->
  <div id="track-info">
    <div id="track-name">No hay nada sonando</div>
    <div id="track-artist">Abre Spotify en un dispositivo</div>
    <div id="track-album"></div>
  </div>

  <!-- Progress -->
  <div id="progress-container">
    <div id="progress-bar-bg" onclick="seekTo(event)">
      <div id="progress-bar"></div>
    </div>
    <div id="progress-times">
      <span id="time-elapsed">0:00</span>
      <span id="time-total">0:00</span>
    </div>
  </div>

  <!-- Controls -->
  <div id="controls">
    <button class="ctrl-btn ctrl-sm" id="btn-shuffle" onclick="toggleShuffle()">🔀</button>
    <button class="ctrl-btn ctrl-md" onclick="api('POST','/api/previous')">⏮</button>
    <button class="ctrl-btn ctrl-lg" id="btn-play" onclick="togglePlay()">▶</button>
    <button class="ctrl-btn ctrl-md" onclick="api('POST','/api/next')">⏭</button>
    <button class="ctrl-btn ctrl-sm" id="btn-repeat" onclick="toggleRepeat()">🔁</button>
  </div>

  <!-- Volume -->
  <div id="volume-container">
    <span class="vol-icon">🔉</span>
    <input type="range" id="volume-slider" min="0" max="100" value="50"
      oninput="setVolume(this.value)">
    <span class="vol-icon">🔊</span>
  </div>

  <!-- Nav -->
  <div id="nav-bar">
    <button class="nav-btn" onclick="openSheet('search')">🔍 Buscar</button>
    <button class="nav-btn" onclick="openSheet('queue')">📋 Cola</button>
  </div>
</div>

<!-- Search Sheet -->
<div class="sheet-overlay" id="search-overlay" onclick="closeSheet('search')"></div>
<div class="sheet" id="search-sheet">
  <div class="sheet-handle"></div>
  <div class="sheet-header">
    <span class="sheet-title">Buscar</span>
    <button class="sheet-close" onclick="closeSheet('search')">✕</button>
  </div>
  <div class="sheet-body">
    <div id="search-input-wrapper">
      <input type="text" id="search-input" placeholder="Canciones, artistas o playlists..."
        oninput="debounceSearch(this.value)">
    </div>
    <div id="search-results">
      <div class="empty-state">Busca canciones, artistas o playlists</div>
    </div>
  </div>
</div>

<!-- Queue Sheet -->
<div class="sheet-overlay" id="queue-overlay" onclick="closeSheet('queue')"></div>
<div class="sheet" id="queue-sheet">
  <div class="sheet-handle"></div>
  <div class="sheet-header">
    <span class="sheet-title">Cola de reproduccion</span>
    <button class="sheet-close" onclick="closeSheet('queue')">✕</button>
  </div>
  <div class="sheet-body">
    <div id="queue-list">
      <div class="empty-state">Cargando cola...</div>
    </div>
  </div>
</div>

<script>
// --- State ---
let currentTrackId = null;
let isPlaying = false;
let progressMs = 0;
let durationMs = 0;
let lastPollTime = 0;
let pollInterval = 5000;
let pollTimer = null;
let animFrame = null;
let searchTimeout = null;
let volumeTimeout = null;

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  if (window.Telegram && Telegram.WebApp) {
    Telegram.WebApp.expand();
    Telegram.WebApp.BackButton.onClick(() => {
      if (document.querySelector('.sheet.open')) {
        closeAllSheets();
      }
    });
  }
  poll();
  startProgressAnimation();
});

// --- API helper ---
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 204) return null;
  if (!res.ok) return null;
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// --- Polling ---
async function poll() {
  try {
    const data = await api('GET', '/api/now-playing');
    if (data && data.item) {
      updatePlayer(data);
    } else if (data === null) {
      showNoPlayback();
    }
  } catch (e) {
    console.error('Poll error:', e);
  }
  pollTimer = setTimeout(poll, pollInterval);
}

function updatePlayer(data) {
  const track = data.item;
  const newId = track.id;
  isPlaying = data.is_playing;

  // Update track info
  document.getElementById('track-name').textContent = track.name;
  document.getElementById('track-artist').textContent =
    track.artists.map(a => a.name).join(', ');
  document.getElementById('track-album').textContent = track.album.name;

  // Update progress
  progressMs = data.progress_ms;
  durationMs = track.duration_ms;
  lastPollTime = Date.now();
  updateProgressBar();

  // Update play button
  document.getElementById('btn-play').textContent = isPlaying ? '⏸' : '▶';

  // Update album art + dynamic bg if track changed
  if (newId !== currentTrackId) {
    currentTrackId = newId;
    const img = document.getElementById('album-art');
    const placeholder = document.getElementById('album-art-placeholder');
    if (track.album.images && track.album.images.length > 0) {
      img.src = track.album.images[0].url;
      img.style.display = 'block';
      placeholder.style.display = 'none';
      img.onload = () => extractColors(img);
    } else {
      img.style.display = 'none';
      placeholder.style.display = 'flex';
      resetBackground();
    }
  }
}

function showNoPlayback() {
  document.getElementById('track-name').textContent = 'No hay nada sonando';
  document.getElementById('track-artist').textContent = 'Abre Spotify en un dispositivo';
  document.getElementById('track-album').textContent = '';
  document.getElementById('btn-play').textContent = '▶';
  document.getElementById('progress-bar').style.width = '0%';
  document.getElementById('time-elapsed').textContent = '0:00';
  document.getElementById('time-total').textContent = '0:00';
  isPlaying = false;
}

// --- Progress animation ---
function startProgressAnimation() {
  function frame() {
    if (isPlaying && durationMs > 0) {
      const elapsed = Date.now() - lastPollTime;
      const current = Math.min(progressMs + elapsed, durationMs);
      const pct = (current / durationMs) * 100;
      document.getElementById('progress-bar').style.width = pct + '%';
      document.getElementById('time-elapsed').textContent = formatMs(current);
      document.getElementById('time-total').textContent = formatMs(durationMs);
    }
    animFrame = requestAnimationFrame(frame);
  }
  frame();
}

function updateProgressBar() {
  if (durationMs > 0) {
    const pct = (progressMs / durationMs) * 100;
    document.getElementById('progress-bar').style.width = pct + '%';
    document.getElementById('time-elapsed').textContent = formatMs(progressMs);
    document.getElementById('time-total').textContent = formatMs(durationMs);
  }
}

function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  const min = Math.floor(s / 60);
  const sec = s % 60;
  return min + ':' + (sec < 10 ? '0' : '') + sec;
}

// --- Controls ---
async function togglePlay() {
  if (isPlaying) {
    await api('PUT', '/api/pause');
    isPlaying = false;
    document.getElementById('btn-play').textContent = '▶';
  } else {
    await api('PUT', '/api/play');
    isPlaying = true;
    document.getElementById('btn-play').textContent = '⏸';
    lastPollTime = Date.now();
  }
}

async function toggleShuffle() {
  // Toggle via Spotify API — simplified, always toggles
  const btn = document.getElementById('btn-shuffle');
  const isActive = btn.classList.toggle('ctrl-active');
  // Note: actual shuffle toggle needs player state; for v1 this is visual-only
}

async function toggleRepeat() {
  const btn = document.getElementById('btn-repeat');
  const isActive = btn.classList.toggle('ctrl-active');
}

function setVolume(val) {
  clearTimeout(volumeTimeout);
  volumeTimeout = setTimeout(() => {
    api('PUT', '/api/volume?percent=' + val);
  }, 300);
}

async function seekTo(e) {
  if (durationMs <= 0) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  const posMs = Math.floor(pct * durationMs);
  progressMs = posMs;
  lastPollTime = Date.now();
  updateProgressBar();
  // Spotify seek endpoint
  await fetch('/api/seek?position_ms=' + posMs, { method: 'PUT' });
}

// --- Dynamic background colors ---
function extractColors(img) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 4; canvas.height = 4;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, 4, 4);
    const data = ctx.getImageData(0, 0, 4, 4).data;
    // Sample corners
    const c1 = [data[0], data[1], data[2]];
    const c2 = [data[12], data[13], data[14]];
    const bg = document.getElementById('bg-gradient');
    bg.style.background =
      'linear-gradient(135deg, rgb(' + c1.join(',') + '), rgb(' + c2.join(',') + '))';
  } catch {
    resetBackground();
  }
}

function resetBackground() {
  document.getElementById('bg-gradient').style.background =
    'linear-gradient(135deg, #1a1a2e, #2d1b69)';
}

// --- Sheets ---
function openSheet(name) {
  document.getElementById(name + '-overlay').classList.add('open');
  document.getElementById(name + '-sheet').classList.add('open');
  if (window.Telegram) Telegram.WebApp.BackButton.show();
  if (name === 'search') {
    setTimeout(() => document.getElementById('search-input').focus(), 350);
  }
  if (name === 'queue') loadQueue();
}

function closeSheet(name) {
  document.getElementById(name + '-overlay').classList.remove('open');
  document.getElementById(name + '-sheet').classList.remove('open');
  if (window.Telegram && !document.querySelector('.sheet.open')) {
    Telegram.WebApp.BackButton.hide();
  }
}

function closeAllSheets() {
  closeSheet('search');
  closeSheet('queue');
}

// --- Search ---
function debounceSearch(q) {
  clearTimeout(searchTimeout);
  if (!q.trim()) {
    document.getElementById('search-results').innerHTML =
      '<div class="empty-state">Busca canciones, artistas o playlists</div>';
    return;
  }
  searchTimeout = setTimeout(() => doSearch(q), 400);
}

async function doSearch(q) {
  document.getElementById('search-results').innerHTML =
    '<div class="skeleton" style="height:44px;margin:8px 0"></div>'.repeat(5);

  const data = await api('GET', '/api/search?q=' + encodeURIComponent(q));
  if (!data) {
    document.getElementById('search-results').innerHTML =
      '<div class="empty-state">Error en la busqueda</div>';
    return;
  }

  let html = '';

  // Tracks
  if (data.tracks && data.tracks.items.length > 0) {
    html += '<div class="result-section"><div class="result-section-title">Canciones</div>';
    for (const t of data.tracks.items) {
      const img = t.album.images.length > 0 ? t.album.images[t.album.images.length - 1].url : '';
      html += '<div class="result-item" onclick="playUri(\\'' + t.uri + '\\')">' +
        '<img class="result-img" src="' + img + '">' +
        '<div class="result-text"><div class="result-name">' + esc(t.name) + '</div>' +
        '<div class="result-sub">' + esc(t.artists.map(a => a.name).join(', ')) + '</div></div></div>';
    }
    html += '</div>';
  }

  // Artists
  if (data.artists && data.artists.items.length > 0) {
    html += '<div class="result-section"><div class="result-section-title">Artistas</div>';
    for (const a of data.artists.items) {
      const img = a.images && a.images.length > 0 ? a.images[a.images.length - 1].url : '';
      html += '<div class="result-item" onclick="searchArtistTracks(\\'' + a.id + '\\', \\'' + esc(a.name) + '\\')">' +
        '<img class="result-img circle" src="' + img + '">' +
        '<div class="result-text"><div class="result-name">' + esc(a.name) + '</div>' +
        '<div class="result-sub">Artista</div></div></div>';
    }
    html += '</div>';
  }

  // Playlists
  if (data.playlists && data.playlists.items.length > 0) {
    html += '<div class="result-section"><div class="result-section-title">Playlists</div>';
    for (const p of data.playlists.items) {
      const img = p.images && p.images.length > 0 ? p.images[0].url : '';
      html += '<div class="result-item" onclick="playContext(\\'' + p.uri + '\\')">' +
        '<img class="result-img" src="' + img + '">' +
        '<div class="result-text"><div class="result-name">' + esc(p.name) + '</div>' +
        '<div class="result-sub">' + esc(p.description || '') + '</div></div></div>';
    }
    html += '</div>';
  }

  if (!html) html = '<div class="empty-state">Sin resultados</div>';
  document.getElementById('search-results').innerHTML = html;
}

async function searchArtistTracks(artistId, artistName) {
  document.getElementById('search-results').innerHTML =
    '<div class="skeleton" style="height:44px;margin:8px 0"></div>'.repeat(5);

  const data = await api('GET', '/api/search?q=artist:' + encodeURIComponent(artistName) + '&type=track');
  if (!data || !data.tracks) return;

  let html = '<div class="result-section"><div class="result-section-title">Canciones de ' + esc(artistName) + '</div>';
  for (const t of data.tracks.items) {
    const img = t.album.images.length > 0 ? t.album.images[t.album.images.length - 1].url : '';
    html += '<div class="result-item" onclick="playUri(\\'' + t.uri + '\\')">' +
      '<img class="result-img" src="' + img + '">' +
      '<div class="result-text"><div class="result-name">' + esc(t.name) + '</div>' +
      '<div class="result-sub">' + esc(t.album.name) + '</div></div></div>';
  }
  html += '</div>';
  document.getElementById('search-results').innerHTML = html;
}

async function playUri(uri) {
  await api('POST', '/api/play-uri', { uri });
  closeSheet('search');
  // Quick re-poll
  clearTimeout(pollTimer);
  setTimeout(poll, 500);
}

async function playContext(contextUri) {
  await api('POST', '/api/play-uri', { context_uri: contextUri });
  closeSheet('search');
  clearTimeout(pollTimer);
  setTimeout(poll, 500);
}

// --- Queue ---
async function loadQueue() {
  const list = document.getElementById('queue-list');
  list.innerHTML = '<div class="skeleton" style="height:44px;margin:8px 0"></div>'.repeat(5);

  const data = await api('GET', '/api/queue');
  if (!data) {
    list.innerHTML = '<div class="empty-state">No se pudo cargar la cola</div>';
    return;
  }

  let html = '';

  // Currently playing
  if (data.currently_playing) {
    const t = data.currently_playing;
    const img = t.album && t.album.images.length > 0 ? t.album.images[t.album.images.length - 1].url : '';
    html += '<div class="queue-np-label">Reproduciendo ahora</div>';
    html += '<div class="queue-item now-playing">' +
      '<img class="result-img" src="' + img + '">' +
      '<div class="result-text"><div class="result-name">' + esc(t.name) + '</div>' +
      '<div class="result-sub">' + esc(t.artists.map(a => a.name).join(', ')) + '</div></div></div>';
  }

  // Queue
  if (data.queue && data.queue.length > 0) {
    html += '<div style="margin-top:16px;margin-bottom:8px;font-size:13px;font-weight:600;color:#a0a0b0;text-transform:uppercase;letter-spacing:0.5px">Siguiente</div>';
    for (const t of data.queue.slice(0, 20)) {
      const img = t.album && t.album.images.length > 0 ? t.album.images[t.album.images.length - 1].url : '';
      html += '<div class="queue-item" onclick="playUri(\\'' + t.uri + '\\')">' +
        '<img class="result-img" src="' + img + '">' +
        '<div class="result-text"><div class="result-name">' + esc(t.name) + '</div>' +
        '<div class="result-sub">' + esc(t.artists.map(a => a.name).join(', ')) + '</div></div></div>';
    }
  }

  if (!html) html = '<div class="empty-state">La cola esta vacia</div>';
  list.innerHTML = html;
}

// --- Utils ---
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// --- Visibility / focus ---
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    pollInterval = 15000;
  } else {
    pollInterval = 5000;
    clearTimeout(pollTimer);
    poll();
  }
});
</script>
</body>
</html>`;
}
```

- [ ] **Step 2: Update index.ts to serve the app HTML**

Replace the placeholder in `index.ts`:

```typescript
import { handleApi } from './api';
import { getAppHtml } from './app';

export interface Env {
  SPOTIFY_AUTH_WORKER: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '') {
      return new Response(getAppHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, url, env.SPOTIFY_AUTH_WORKER);
    }

    return new Response('Not found', { status: 404 });
  },
};
```

- [ ] **Step 3: Test locally**

```bash
cd spotify-miniapp-worker && npx wrangler dev
```

Open `http://localhost:8787/` in browser. Verify:
- Dark glass layout renders
- Album art placeholder visible
- Controls, progress bar, volume slider all present
- "Buscar" and "Cola" buttons open sheets
- Sheets close with X or overlay tap

If Spotify is active, verify:
- Track info populates after poll
- Progress bar animates
- Album art loads

Stop dev server.

- [ ] **Step 4: Commit**

```bash
git add spotify-miniapp-worker/src/app.ts spotify-miniapp-worker/src/index.ts
git commit -m "feat: spotify mini app UI — dark glass player with search and queue"
```

---

## Task 4: Add seek endpoint + missing API route

**Files:**
- Modify: `spotify-miniapp-worker/src/api.ts`

The player UI calls `/api/seek?position_ms=N` for seeking within a track, but this route isn't in api.ts yet.

- [ ] **Step 1: Add seek route to api.ts**

Add this case inside the `switch (path)` block, after the `/volume` case:

```typescript
    case '/seek': {
      const posMs = url.searchParams.get('position_ms') ?? '0';
      return spotifyFetch(
        authWorkerUrl,
        'PUT',
        `/me/player/seek?position_ms=${encodeURIComponent(posMs)}`
      );
    }
```

- [ ] **Step 2: Test seek**

```bash
cd spotify-miniapp-worker && npx wrangler dev
```

While Spotify is playing, run:
```bash
curl -X PUT "http://localhost:8787/api/seek?position_ms=30000"
```

Expected: track jumps to 0:30 in Spotify.

- [ ] **Step 3: Commit**

```bash
git add spotify-miniapp-worker/src/api.ts
git commit -m "feat: add seek endpoint to spotify miniapp API"
```

---

## Task 5: Deploy + configure Telegram entry points

**Files:**
- No new files — deploy + BotFather config

- [ ] **Step 1: Deploy the worker**

```bash
cd spotify-miniapp-worker && npx wrangler deploy
```

Expected: Deployed to `https://spotify-miniapp.carlos-cb4.workers.dev`

- [ ] **Step 2: Verify deployed app**

Open `https://spotify-miniapp.carlos-cb4.workers.dev` in browser. Verify the full player loads and connects to Spotify.

- [ ] **Step 3: Configure Mini App in BotFather**

This is a manual step for Cal. Instructions:

1. Open @BotFather in Telegram
2. Send `/newapp`
3. Select @calclaudecode_bot
4. Title: `Spotify`
5. Description: `Spotify player`
6. Upload a 640x360 photo (e.g. a screenshot of the player)
7. Send `skip` for GIF
8. URL: `https://spotify-miniapp.carlos-cb4.workers.dev`
9. Short name: `spotify`

This enables `https://t.me/calclaudecode_bot/spotify` as a deep link.

- [ ] **Step 4: Add "Abrir Player" button to Spotify inline menu**

Update the Spotify control menu in the Telegram plugin. When the LLM sends the Spotify menu, include this button row:

```json
[{"text": "🎵 Abrir Player", "url": "https://t.me/calclaudecode_bot/spotify"}]
```

This is a URL button (not callback), so it opens the TWA directly in Telegram.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: deploy spotify miniapp worker"
```

---

## Task 6: Update project documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add Spotify Mini App section to CLAUDE.md**

Add after the existing Spotify section:

```markdown
## Spotify Mini App (TWA)
- **Worker:** `https://spotify-miniapp.carlos-cb4.workers.dev` — **desplegado**
- **TWA deep link:** `https://t.me/calclaudecode_bot/spotify`
- **Spec:** `docs/superpowers/specs/2026-04-12-spotify-miniapp-design.md`
- **Funcionalidad:** Player visual, busqueda, queue — estilo Dark Glass
- **Auth:** usa tokens del auth worker existente (single-user)
- **Polling:** cada 5s (15s cuando pierde foco)
```

- [ ] **Step 2: Update deploy commands section**

Add to the existing "Deploy workers" section in CLAUDE.md:

```bash
cd spotify-miniapp-worker && npx wrangler deploy
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add spotify miniapp worker to project documentation"
```

---

## Summary

| Task | What it builds | Estimated |
|------|---------------|-----------|
| 1 | Project scaffold, wrangler config, minimal worker | ~5 min |
| 2 | Spotify API proxy (all routes) | ~5 min |
| 3 | Full player UI — HTML/CSS/JS Dark Glass | ~10 min |
| 4 | Seek endpoint (missed in task 2) | ~2 min |
| 5 | Deploy + Telegram entry points | ~5 min |
| 6 | Documentation update | ~3 min |
