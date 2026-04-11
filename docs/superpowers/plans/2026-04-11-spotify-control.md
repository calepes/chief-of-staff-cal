# Spotify Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Control Spotify playback from Telegram with inline buttons for mechanical actions (play/pause/skip) and Claude for search/discovery.

**Architecture:** Cloudflare Worker handles OAuth + token refresh. spotify-client.ts module in the plugin handles API calls. Mechanical callbacks (pause, play, skip) go through the callback router directly. Search and discovery go through Claude.

**Tech Stack:** Spotify Web API, Cloudflare Workers + KV, Bun/TypeScript

---

### Task 1: Create Spotify Developer App

- [ ] **Step 1: Create app at developer.spotify.com**

Go to https://developer.spotify.com/dashboard and create a new app:
- Name: "Claude Cal Bot"
- Redirect URI: `https://spotify-auth.carlos-cb4.workers.dev/callback`
- APIs: Web API
- Scopes: `user-modify-playback-state`, `user-read-playback-state`, `user-read-currently-playing`

- [ ] **Step 2: Save client_id and client_secret**

Add to `~/.claude/channels/telegram/.env`:
```
SPOTIFY_CLIENT_ID=xxx
SPOTIFY_CLIENT_SECRET=xxx
SPOTIFY_AUTH_WORKER_URL=https://spotify-auth.carlos-cb4.workers.dev
```

---

### Task 2: Create Cloudflare Worker for OAuth

**Files:**
- Create: `spotify-auth-worker/src/index.ts`
- Create: `spotify-auth-worker/wrangler.toml`
- Create: `spotify-auth-worker/package.json`

- [ ] **Step 1: Create wrangler.toml**

```toml
name = "spotify-auth"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
SPOTIFY_REDIRECT_URI = "https://spotify-auth.carlos-cb4.workers.dev/callback"

[[kv_namespaces]]
binding = "SPOTIFY_TOKENS"
id = "TBD_AFTER_CREATE"
```

- [ ] **Step 2: Create KV namespace**

```bash
cd spotify-auth-worker
npx wrangler kv:namespace create SPOTIFY_TOKENS
```

Update wrangler.toml with the returned ID.

- [ ] **Step 3: Create package.json**

```json
{
  "name": "spotify-auth-worker",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^3.0.0"
  }
}
```

- [ ] **Step 4: Create src/index.ts**

```ts
interface Env {
  SPOTIFY_TOKENS: KVNamespace
  SPOTIFY_CLIENT_ID: string
  SPOTIFY_CLIENT_SECRET: string
  SPOTIFY_REDIRECT_URI: string
}

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize'
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token'
const SCOPES = 'user-modify-playback-state user-read-playback-state user-read-currently-playing'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/login') {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: env.SPOTIFY_CLIENT_ID,
        scope: SCOPES,
        redirect_uri: env.SPOTIFY_REDIRECT_URI,
        state: crypto.randomUUID(),
      })
      return Response.redirect(`${SPOTIFY_AUTH_URL}?${params}`)
    }

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code')
      if (!code) return new Response('Missing code', { status: 400 })

      const res = await fetch(SPOTIFY_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: env.SPOTIFY_REDIRECT_URI,
        }),
      })

      const data = await res.json() as any
      if (data.error) return new Response(`Error: ${data.error}`, { status: 400 })

      await env.SPOTIFY_TOKENS.put('access_token', data.access_token, { expirationTtl: data.expires_in })
      await env.SPOTIFY_TOKENS.put('refresh_token', data.refresh_token)

      return new Response('Spotify connected! You can close this tab.')
    }

    if (url.pathname === '/token') {
      let token = await env.SPOTIFY_TOKENS.get('access_token')
      if (!token) {
        const refresh = await env.SPOTIFY_TOKENS.get('refresh_token')
        if (!refresh) return new Response('Not authenticated', { status: 401 })

        const res = await fetch(SPOTIFY_TOKEN_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refresh,
          }),
        })

        const data = await res.json() as any
        if (data.error) return new Response(`Refresh failed: ${data.error}`, { status: 401 })

        token = data.access_token
        await env.SPOTIFY_TOKENS.put('access_token', token!, { expirationTtl: data.expires_in })
        if (data.refresh_token) {
          await env.SPOTIFY_TOKENS.put('refresh_token', data.refresh_token)
        }
      }

      return new Response(JSON.stringify({ access_token: token }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response('Not found', { status: 404 })
  },
}
```

- [ ] **Step 5: Set secrets and deploy**

```bash
cd spotify-auth-worker
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npm run deploy
```

- [ ] **Step 6: Test auth flow**

Visit `https://spotify-auth.carlos-cb4.workers.dev/login` → Spotify login → redirect → "Spotify connected!"

- [ ] **Step 7: Commit**

```bash
cd ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal
git add spotify-auth-worker/
git commit -m "feat: Cloudflare Worker for Spotify OAuth token management"
```

---

### Task 3: Create Spotify Client Module

**Files:**
- Create: `telegram-plugin/spotify-client.ts`

- [ ] **Step 1: Create spotify-client.ts**

```ts
// telegram-plugin/spotify-client.ts
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
const ENV_FILE = join(STATE_DIR, '.env')

function getWorkerUrl(): string {
  try {
    const content = readFileSync(ENV_FILE, 'utf-8')
    const match = content.match(/^SPOTIFY_AUTH_WORKER_URL=(.*)$/m)
    return match?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''
  } catch { return '' }
}

async function getToken(): Promise<string> {
  const url = getWorkerUrl()
  if (!url) throw new Error('SPOTIFY_AUTH_WORKER_URL not set')
  const res = await fetch(`${url}/token`)
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`)
  const data = await res.json() as { access_token: string }
  return data.access_token
}

const SPOTIFY_API = 'https://api.spotify.com/v1'

async function spotifyFetch(path: string, method = 'PUT', body?: any): Promise<Response> {
  const token = await getToken()
  return fetch(`${SPOTIFY_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

export async function play(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await spotifyFetch('/me/player/play')
    return { ok: res.ok || res.status === 204 }
  } catch (e) { return { ok: false, error: String(e) } }
}

export async function pause(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await spotifyFetch('/me/player/pause')
    return { ok: res.ok || res.status === 204 }
  } catch (e) { return { ok: false, error: String(e) } }
}

export async function skipNext(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await spotifyFetch('/me/player/next', 'POST')
    return { ok: res.ok || res.status === 204 }
  } catch (e) { return { ok: false, error: String(e) } }
}

export async function skipPrevious(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await spotifyFetch('/me/player/previous', 'POST')
    return { ok: res.ok || res.status === 204 }
  } catch (e) { return { ok: false, error: String(e) } }
}

export async function setVolume(percent: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const clamped = Math.max(0, Math.min(100, percent))
    const res = await spotifyFetch(`/me/player/volume?volume_percent=${clamped}`, 'PUT')
    return { ok: res.ok || res.status === 204 }
  } catch (e) { return { ok: false, error: String(e) } }
}

export async function nowPlaying(): Promise<{ ok: boolean; track?: string; artist?: string; error?: string }> {
  try {
    const res = await spotifyFetch('/me/player/currently-playing', 'GET')
    if (res.status === 204) return { ok: true, track: 'Nothing playing' }
    const data = await res.json() as any
    return {
      ok: true,
      track: data.item?.name ?? 'Unknown',
      artist: data.item?.artists?.map((a: any) => a.name).join(', ') ?? 'Unknown',
    }
  } catch (e) { return { ok: false, error: String(e) } }
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal/telegram-plugin && bun build --target=bun spotify-client.ts --outdir=/tmp/test-build
```

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal
git add telegram-plugin/spotify-client.ts
git commit -m "feat: add Spotify client module for playback control"
```

---

### Task 4: Add Spotify Routes to Callback Router

**Files:**
- Modify: `telegram-plugin/callback-router.ts`

- [ ] **Step 1: Add Spotify imports and routes**

Add to callback-router.ts, after the Notion imports:

```ts
import { play, pause, skipNext, skipPrevious, setVolume, nowPlaying } from './spotify-client'
```

Add before the `return null` at the end of `routeCallback`:

```ts
  // spotify:play
  if (data === 'spotify:play') {
    const r = await play()
    const np = r.ok ? await nowPlaying() : null
    return { editText: r.ok ? `▶️ Playing: ${np?.track} — ${np?.artist}` : `❌ ${r.error}`, toast: '▶️' }
  }

  // spotify:pause
  if (data === 'spotify:pause') {
    const r = await pause()
    return { editText: r.ok ? '⏸ Paused' : `❌ ${r.error}`, toast: '⏸' }
  }

  // spotify:skip
  if (data === 'spotify:skip') {
    const r = await skipNext()
    if (r.ok) {
      await new Promise(resolve => setTimeout(resolve, 300))
      const np = await nowPlaying()
      return { editText: `⏭ ${np.track} — ${np.artist}`, toast: '⏭' }
    }
    return { editText: `❌ ${r.error}`, toast: 'Error' }
  }

  // spotify:back
  if (data === 'spotify:back') {
    const r = await skipPrevious()
    if (r.ok) {
      await new Promise(resolve => setTimeout(resolve, 300))
      const np = await nowPlaying()
      return { editText: `⏮ ${np.track} — ${np.artist}`, toast: '⏮' }
    }
    return { editText: `❌ ${r.error}`, toast: 'Error' }
  }

  // spotify:volup / spotify:voldown
  if (data === 'spotify:volup' || data === 'spotify:voldown') {
    const delta = data === 'spotify:volup' ? 10 : -10
    const r = await setVolume(50 + delta) // TODO: read current volume first
    return { editText: r.ok ? `🔊 Volume adjusted` : `❌ ${r.error}`, toast: '🔊' }
  }
```

- [ ] **Step 2: Verify compilation**

```bash
cd ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal/telegram-plugin && bun build --target=bun callback-router.ts --outdir=/tmp/test-build
```

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal
git add telegram-plugin/callback-router.ts
git commit -m "feat: add Spotify mechanical callbacks to router"
```

---

### Task 5: Deploy and Test Spotify

- [ ] **Step 1: Deploy updated plugin files to cache**

```bash
cp ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal/telegram-plugin/{server,notion-client,callback-router,spotify-client}.ts ~/.claude/plugins/cache/claude-plugins-official/telegram/*/
```

- [ ] **Step 2: Authenticate with Spotify**

Visit `https://spotify-auth.carlos-cb4.workers.dev/login` and complete OAuth.

- [ ] **Step 3: Test from Telegram**

Send "qué suena" → Claude reads now playing and sends control buttons.
Tap ⏸ → Spotify pauses in <1s.
Tap ▶️ → Spotify resumes.
Tap ⏭ → skips to next track.

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal
git add -A
git commit -m "feat: Spotify control from Telegram complete"
```
