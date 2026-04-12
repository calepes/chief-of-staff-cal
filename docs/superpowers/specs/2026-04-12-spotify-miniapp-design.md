# Spotify Mini App (Telegram Web App) — Design Spec

**Fecha:** 2026-04-12
**Status:** approved
**Autor:** Cal + Claude

## Objetivo

Mini app de Spotify embebida en Telegram (TWA) que ofrece un player visual completo con controles de reproduccion, busqueda de contenido, y vista de queue. Reemplaza la interaccion por botones inline con una experiencia rich UI estilo app nativa.

## Arquitectura

### Worker unico

Un solo Cloudflare Worker (`spotify-miniapp.carlos-cb4.workers.dev`) que:

- Sirve el HTML/CSS/JS de la mini app (inline, single response)
- Hace proxy a la Spotify Web API
- Obtiene tokens del auth worker existente (`spotify-auth.carlos-cb4.workers.dev/token`)
- No tiene estado propio — tokens viven en KV del auth worker

### Flujo de datos

```
Telegram TWA → Worker (GET /) → HTML
TWA JS → Worker API routes → Auth Worker (/token) → Spotify Web API
```

### Rutas del Worker

| Ruta | Metodo | Descripcion |
|------|--------|-------------|
| `/` | GET | Sirve la mini app (HTML completo) |
| `/api/now-playing` | GET | Proxy a currently-playing |
| `/api/play` | PUT | Reanudar reproduccion |
| `/api/pause` | PUT | Pausar reproduccion |
| `/api/next` | POST | Skip siguiente |
| `/api/previous` | POST | Skip anterior |
| `/api/volume?percent=N` | PUT | Ajustar volumen (0-100) |
| `/api/queue` | GET | Cola de reproduccion |
| `/api/search?q=X&type=track,artist,playlist` | GET | Busqueda |
| `/api/play-uri` | POST | Reproducir URI especifico. Body: `{uri?, context_uri?, offset?}` |

Cada ruta API:
1. Llama a `spotify-auth.carlos-cb4.workers.dev/token` para obtener access_token
2. Pasa el token a la Spotify Web API correspondiente
3. Retorna la respuesta al cliente

### Autenticacion

Single-user (Cal). El auth worker existente ya tiene los tokens en KV con refresh automatico. La mini app no implementa OAuth propio.

## UI

### Estilo: Dark Glass

- **Fondo:** gradiente oscuro dinamico basado en colores dominantes de la caratula. Fallback: `#1a1a2e → #2d1b69`
- **Elementos:** backdrop-filter blur, bordes sutiles `rgba(255,255,255,0.12)`, sombras profundas
- **Texto:** blanco para titulos, gris claro (`#a0a0b0`) para secundario
- **Acentos:** verde Spotify (`#1DB954`) para barra de progreso y estados activos
- **Controles:** botones con fondo glass `rgba(255,255,255,0.1)` + blur

### Vista principal: Player

Layout fullscreen, vertical:

1. **Fondo dinamico** — gradiente extraido de la caratula (canvas sampling) con fallback fijo
2. **Caratula** — centrada, ~60% del ancho, border-radius 16px, contenedor glass con sombra
3. **Track info** — nombre (bold, blanco), artista (gris claro, tappeable), album (gris sutil)
4. **Barra de progreso** — clickeable/draggable, gradiente verde Spotify, fondo glass. Timestamps a los lados (elapsed / total). Animacion local con CSS entre polls
5. **Controles** — fila centrada: shuffle, previous, play/pause (boton grande glass), next, repeat
6. **Volumen** — slider horizontal debajo de controles
7. **Navegacion** — dos iconos glass en la parte inferior: busqueda (lupa) y queue (lista)

### Sheet: Busqueda

Apertura: desliza desde abajo, cubre ~85% de la pantalla. Fondo dark glass con blur del player detras.

- **Input** — arriba, estilo glass, icono de lupa, autofocus al abrir
- **Resultados** — lista scrolleable con 3 secciones colapsables:
  - **Canciones:** caratula mini (40px), nombre, artista. Tap = reproduce inmediatamente
  - **Artistas:** foto circular, nombre. Tap = muestra top tracks del artista
  - **Playlists:** cover, nombre, descripcion corta. Tap = muestra tracks de la playlist
- **Estado vacio:** texto "Busca canciones, artistas o playlists"
- **Loading:** skeleton con efecto shimmer glass
- **Sub-vista:** al tocar artista/playlist, listado de tracks reproducibles

Flujo: buscar → tap cancion → reproduce via `/api/play-uri` → sheet se cierra → player se actualiza.

Cerrar: swipe down, boton X, o `Telegram.WebApp.BackButton`.

### Sheet: Queue

Mismo patron de apertura que busqueda.

- **Header:** "Cola de reproduccion" + indicador de tracks restantes
- **Now Playing:** primer item destacado con borde glass brillante + animacion de barras de audio
- **Next Up:** lista scrolleable del resto de la cola
- **Cada item:** caratula mini (40px), nombre, artista. Tap = salta a esa cancion via `/api/next` repetido (la API no soporta skip-to-position en queue, solo skip next)

**Limitaciones de la API:** Spotify Web API permite ver la queue pero no reordenar, eliminar, ni saltar a una posicion arbitraria. Para "skip to" un track en la queue, se ejecutan N skips consecutivos. Alternativa: reproducir el track directamente via play-uri (sale del contexto de la queue).

Cerrar: mismo patron que busqueda.

### Telegram WebApp Integration

- `Telegram.WebApp.expand()` al cargar para pantalla completa
- `Telegram.WebApp.themeParams` disponible para adaptar colores si necesario
- `Telegram.WebApp.BackButton.show()` al abrir sheets, `.hide()` al cerrar
- `Telegram.WebApp.BackButton.onClick()` cierra el sheet activo

## Polling y estado

- Polling cada **5 segundos** a `/api/now-playing` para mantener estado actualizado
- **Animacion local de progreso:** entre polls, la barra de progreso avanza con JS/CSS basado en `progress_ms` + `duration_ms` + timestamp del ultimo poll. Esto da fluidez visual sin trafico extra
- **Deteccion de cambio de cancion:** si el track ID cambia entre polls, actualizar caratula, info, colores de fondo
- **Manejo de 429 (rate limit):** backoff exponencial, reintentar despues del `Retry-After` header
- **Sin actividad:** si la TWA pierde foco o el usuario no interactua por 60s, reducir polling a 15s. Restaurar al volver

## Puntos de entrada

### Boton en menu Spotify (inline)

Agregar al menu de controles Spotify existente:

```json
{"text": "🎵 Abrir Player", "url": "https://t.me/calclaudecode_bot/spotify"}
```

### Comando /player

Registrar comando que abre la TWA directamente.

### Configuracion BotFather (una vez)

- Registrar Mini App: nombre "Spotify", short_name "spotify"
- URL de la web app: `https://spotify-miniapp.carlos-cb4.workers.dev`
- Esto habilita `https://t.me/calclaudecode_bot/spotify` como deep link

## Estructura del proyecto

```
spotify-miniapp-worker/
├── wrangler.toml
├── package.json
├── src/
│   ├── index.ts          — Worker entry, router
│   ├── api.ts            — Rutas API (proxy a Spotify)
│   ├── spotify.ts        — Cliente Spotify (getToken + fetch wrapper)
│   └── app.html.ts       — Template HTML/CSS/JS exportado como string
```

HTML/CSS/JS todo inline en una sola respuesta HTTP. Sin assets separados, sin build step para el frontend.

## Deploy

```bash
cd spotify-miniapp-worker && npx wrangler deploy
```

Agregar al CLAUDE.md en seccion "Deploy workers".

## Scope

### En scope (v1)

- Player visual con caratula, controles, barra de progreso animada
- Busqueda de canciones, artistas, playlists
- Reproducir desde resultados de busqueda
- Vista de queue (read-only + skip-to)
- Estilo Dark Glass
- Polling cada 5s con animacion local
- Colores dinamicos de caratula (con fallback)
- Single-user (Cal)
- Puntos de entrada: boton inline + comando /player

### Fuera de scope (v1)

- OAuth multi-user
- Reordenar/editar queue (limitacion API de Spotify)
- Letras de canciones
- Gestion de playlists (crear/editar)
- Modo offline
- WebSocket para updates en tiempo real

## Riesgos y mitigaciones

| Riesgo | Mitigacion |
|--------|-----------|
| Rate limits Spotify (~720 req/hora con polling 5s) | Backoff exponencial en 429s. Reducir polling sin foco |
| Token expiry mid-sesion | Auth worker ya maneja refresh. Si falla, mostrar mensaje "Reconectando..." y reintentar |
| Colores dinamicos de caratula complejos sin libreria | Canvas sampling basico (esquinas + centro). Fallback a gradiente fijo si falla o si imagen es cross-origin |
| Latencia de doble proxy (Worker → Auth → Spotify) | Cache del token por 50min en el worker (tokens duran 60min). Reduce a un solo hop para la mayoria de requests |
