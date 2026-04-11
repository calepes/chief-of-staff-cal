# Spotify Control — Design Spec

## Objetivo
Controlar la reproducción de Spotify desde Telegram: play/pause, skip, back, ver qué suena, buscar y poner canciones/playlists.

## Requisitos
- Spotify Premium (Cal lo tiene)
- Spotify Developer App (crear en developer.spotify.com)
- Cloudflare Worker para OAuth redirect

## Arquitectura

```
Setup (una vez):
Cal → URL de auth → Spotify login → redirect a Worker → Worker guarda tokens en KV → listo

Uso:
Botón ⏯ → callback spotify:play → plugin ejecuta directo → Spotify API → ~200ms
"Pon algo de Coldplay" → LLM → busca en Spotify API → selecciona → play
```

## Componentes

### 1. Spotify Developer App
- Crear en https://developer.spotify.com/dashboard
- Redirect URI: `https://spotify-auth.carlos-cb4.workers.dev/callback`
- Scopes: `user-modify-playback-state`, `user-read-playback-state`, `user-read-currently-playing`
- Guardar `client_id` y `client_secret` en .env del plugin

### 2. Cloudflare Worker (`spotify-auth`)
- Ruta `/login` — genera URL de auth con PKCE, redirige a Spotify
- Ruta `/callback` — recibe code, intercambia por access_token + refresh_token, guarda en KV
- Ruta `/token` — devuelve access_token vigente, refresca si expirado
- KV namespace: `SPOTIFY_TOKENS`

### 3. `spotify-client.ts` (en el plugin)
Módulo que consulta el Worker para obtener token y llama a Spotify Web API:

```ts
class SpotifyClient {
  async play(): Promise<void>
  async pause(): Promise<void>
  async skipNext(): Promise<void>
  async skipPrevious(): Promise<void>
  async nowPlaying(): Promise<Track>
  async search(query: string, type: 'track' | 'album' | 'playlist'): Promise<SearchResults>
  async playUri(uri: string): Promise<void>
  async setVolume(percent: number): Promise<void>
}
```

### 4. Acciones mecánicas en el plugin
Estos callbacks se procesan directo sin LLM:

| Callback | Acción |
|----------|--------|
| `spotify:play` | Reanudar reproducción |
| `spotify:pause` | Pausar |
| `spotify:skip` | Siguiente canción |
| `spotify:back` | Canción anterior |
| `spotify:volup` | Volumen +10% |
| `spotify:voldown` | Volumen -10% |

Respuesta: editMessage con "⏯ Playing: {canción}" o "⏸ Paused".

### 5. Acciones vía LLM
- Buscar y poner una canción/artista/playlist
- "Qué suena" con formato bonito
- Recomendaciones
- Crear cola de reproducción

### 6. Botones de control

Cuando se activa Spotify (menu:spotify o "qué suena"):
```
🎵 Now Playing: Canción — Artista

[⏮] [⏯] [⏭]
[🔉] [🔊]
[🔍 Buscar]
```

### 7. `.env` — nuevas variables
```
SPOTIFY_CLIENT_ID=xxx
SPOTIFY_CLIENT_SECRET=xxx
SPOTIFY_AUTH_WORKER_URL=https://spotify-auth.carlos-cb4.workers.dev
```

## Setup inicial
1. Cal crea app en Spotify Developer Dashboard
2. Deploy Worker a Cloudflare
3. Agregar variables al .env
4. Cal visita `/login` del Worker → autoriza en Spotify → tokens guardados
5. Probar con botón ⏯

## Testing
1. Auth flow: login → callback → token guardado en KV
2. Botón pause → Spotify pausa en <1s
3. "Pon Bohemian Rhapsody" → Claude busca → reproduce
4. "Qué suena" → muestra canción actual con botones de control
