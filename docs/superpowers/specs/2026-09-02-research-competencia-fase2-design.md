# Spec: Research y monitoreo de competencia — Fase 2 (RRSS multimodal)

**Fecha:** 2026-09-02
**Estado:** Aprobado por Cal. **Implementado con un cambio de arquitectura respecto de este spec —
ver "Addendum 2026-09-03" más abajo antes de leer "Arquitectura".**

---

## Addendum 2026-09-03 — cambio de arquitectura a mitad de implementación

Este spec fue aprobado y la implementación arrancó siguiéndolo (scrapers, módulo de media, tipos,
prompt — todo eso quedó tal cual está descrito abajo). **A mitad de camino Cal decidió sacar el
research del daemon de Jano.** Motivo: el research no necesita el LLM del daemon corriendo — es un
job de scraping + análisis + escritura a Notion, disparado por horario o a demanda, sin
conversación. Mantenerlo dentro del daemon significaba pagar el runtime completo de Jano (Agent
SDK, tool `investigarCompetencia`, cron interno `node-cron`) por algo que es, en esencia, un script
batch.

**Qué cambió en concreto** (el resto del documento, salvo lo marcado explícitamente abajo, sigue
describiendo la arquitectura real):

1. **Ya no hay cron interno ni tool de Telegram.** `investigarCompetencia` y
   `scheduleResearchCompetenciaWeekly()` nunca se construyeron — ni existen en `index.ts`,
   `agent-tools.ts` ni `system-prompt.ts`. En su lugar: `daemon-v2/scripts/research-competencia-now.ts`
   (script standalone) disparado por un **cron de launchd externo**
   (`launchd/com.cal.jano-research-competencia.plist`, creado en este repo pero **sin instalar** —
   Cal decide cuándo activarlo) y el comando `/research-competencia` (`~/.claude/commands/`, fuera
   del repo) para correrlo a demanda desde una sesión de Claude Code.
2. **Las cookies NO pasan por el Cookie Broker.** `research-competencia-cookies.ts` (nuevo) lee la
   sesión de Safari **directo** (`Cookies.binarycookies`, requiere Full Disk Access) con una lista
   de dominios **propia y congelada** (`SOCIAL_DOMAINS = ["instagram.com", "tiktok.com",
   "facebook.com", "x.com", "twitter.com"]`) — la whitelist global del broker
   (`~/.claude/config/cookie-jar-domains.json`) **no se tocó para nada de esto**. Motivo real: esa
   whitelist también la consume `fetchAsUser`, una tool que el LLM de Jano invoca con **URL
   arbitraria** — agregarle `facebook.com`/`tiktok.com` ahí le habría dado al modelo acceso
   autenticado a Messenger/DMs, no solo a los perfiles públicos que este research necesita. La
   whitelist ya tenía `x.com`/`instagram.com` desde 2026-07-31 (por otro flujo, Referencias de
   Diseño) — sin tocar tampoco.
3. **`fetchAsUser` se endureció en paralelo, por un hallazgo de esta misma revisión.** Una revisión
   adversarial (2026-09-03) encontró que el riesgo de arriba **ya existía en producción desde
   julio** — X e Instagram llevaban whitelisteados con cookies reales desde el 2026-07-31, sin
   ningún control sobre rutas de mensajería. Se agregó `isPrivateMessagingUrl()` en
   `daemon-v2/src/tools/fetch-as-user.ts`: bloqueo fail-closed de rutas de mensajería privada
   (Messenger, DMs de X/Twitter/Instagram/TikTok), con matching resistente a percent-encoding,
   hostname con punto final (`facebook.com.`) y redirects (el chequeo corre tanto sobre la URL de
   entrada como sobre la URL final tras seguir redirects, porque `fetch` conserva el header Cookie
   en redirects del mismo origen). Detalle completo, incluidos los 4 vectores cerrados y la
   regresión encontrada en una segunda pasada (falsos positivos sobre URLs con `%` mal formado en
   dominios sin mensajería): comentario extenso al inicio de `fetch-as-user.ts`.
4. **La notificación va por @ClaudeCalbot, no por Jano.** `research-competencia-notify.ts` manda el
   resumen vía `NOTIF_BOT_TOKEN` (el bot de notificaciones de Cal, no `COS_TELEGRAM_BOT_TOKEN`) — no
   hay `sendMessage` del daemon involucrado.
5. **El script requiere Full Disk Access y corre vía `node-fda`**, no `node` ni `tsx` directo — el
   permiso está atado al binario `~/.claude/bin/node-fda` específicamente. `package.json` ganó
   `"research:now": "\"$HOME/.claude/bin/node-fda\" --import tsx/esm scripts/research-competencia-now.ts"`.
   El plist de launchd replica exactamente ese comando (sin pasar por `npm run`, que perdería el
   permiso al arrancar el `node` del PATH en vez de `node-fda`).
6. **Los topes de "Topes por corrida" de abajo siguen vigentes tal cual** (8 posts/cuenta, 4
   videos/cuenta, 6 frames/video, se saltean videos >5 min) — eso no cambió. Se sumó, no
   documentado originalmente en este spec, un **deadline de 8 minutos por entidad** para el
   scraping social completo (`research-competencia.ts`), agregado durante la implementación como
   techo del peor caso.
7. **Nada de esto se probó contra las 4 plataformas reales todavía.** Los scrapers están escritos
   con criterio y testeados contra fixtures, pero la verificación en vivo de selectores/JSON
   (Instagram/TikTok tienen JSON embebido más estable; Facebook y X se leen del DOM renderizado vía
   `article`/`[role="article"]`, los más frágiles de los 4) nunca se corrió. La primera corrida real
   (cron o `/research-competencia`) es también la primera prueba de humo end-to-end.

## Propósito

Extender el research de competencia de Yape Bolivia (Fase 1, en producción desde 2026-08-31) con la fuente que Fase 1 dejó explícitamente afuera: lo que los competidores publican en sus propias redes sociales. Fase 1 cubre App Store/Google Play/sitio propio/prensa+LinkedIn — no ve nada de lo que las marcas comunican directo a su audiencia.

El volumen justifica la inversión: el TikTok de altoke tiene 121.5K seguidores contra 4.6K en su Instagram. El grueso de la comunicación comercial de estas marcas (promos, tarifas, lanzamientos, condiciones) vive en video corto, no en texto.

## Alcance

**4 plataformas: Instagram, TikTok, Facebook y X.** Para cada cuenta se procesan tanto posts estáticos (imagen) como videos.

Para los 3 pares banco+billetera se scrapean **ambas** cuentas (banco y billetera), no solo la de la billetera.

### Handles confirmados (búsqueda web 2026-09-02)

| Entidad | Instagram | TikTok | Facebook | X |
|---|---|---|---|---|
| Banco Sol / Altoke | `altoke.bo`, `bancosol_bolivia` | `altoke.bo` | `altoke.bo`, `BancoSolidarioBolivia` | `bancosol` |
| Banco Ganadero / Yolo Pago | `yolopagoapp`, `bancoganadero` | `yolopagoapp` | `YoloPagoApp`, `bg.com.bo` | `yolo_pago` |
| Banco Económico / ZAS | `banco.economico` | *(sin confirmar)* | `banco.economico` | *(no tiene)* |
| Takenos | `takenosapp.bo` | `takenos_app_bo` | *(no tiene)* | `takenosapp` |
| Meru | `meru.app` | *(sin confirmar)* | `getmeruapp` | `getmeru` |
| Peso App | `peso.latam` | `peso.latam` | *(no encontrado)* | *(no tiene)* |

~24 cuentas en total. Los handles sin confirmar se resuelven durante la implementación; si no aparece cuenta oficial, esa combinación entidad×plataforma simplemente no se consulta (no se inventa un handle).

---

## Arquitectura

> La tabla de abajo es la del spec original — sigue vigente salvo la fila de `cookie-jar.ts`
> (Cookie Broker), que el research **no usa**: ver punto 2 del Addendum arriba.
> `research-competencia-cookies.ts` reemplaza esa pieza con lectura directa de Safari, fuera del
> Cookie Broker.

Reusa piezas ya probadas en producción — no se construye nada de cero:

| Pieza existente | Qué aporta |
|---|---|
| ~~`cookie-jar.ts` (Cookie Broker)~~ → **`research-competencia-cookies.ts` (nuevo, propio)** | Cookies logueadas por dominio — pero leídas de Safari directo (`Cookies.binarycookies`, FDA), no del Cookie Broker/KV. Ver Addendum punto 2. |
| `design-capture.ts` (patrón) | Playwright headless in-process, sin exponerle control de browser al LLM |
| `vision.ts` → `analyzePhoto()` | Análisis de imagen vía OpenRouter (`qwen3-vl`) |
| `whisper.ts` → `transcribeAudio()` | Transcripción (ElevenLabs con fallback a whisper local) |

### Flujo por cuenta

1. **Scraping** — Playwright headless con cookies inyectadas carga el perfil y extrae los posts recientes: caption, fecha, tipo de media, URL de la media, URL del post.
2. **Filtro de timeframe** — se descartan los posts fuera de la ventana de la corrida antes de procesar media (el paso caro).
3. **Imágenes** — descarga → `analyzePhoto({task:"describe"})` → texto descriptivo (captura tarifas, condiciones y copy que viven solo dentro de la imagen).
4. **Videos** — descarga → `ffmpeg` extrae audio + frames → `transcribeAudio()` sobre el audio y `analyzePhoto()` sobre cada frame.
5. **Consolidación** — caption + descripción de imágenes + transcripción + lectura de frames se concatenan como texto y entran al prompt del agente como un dato mecánico más (igual que `siteText` hoy), sin tocar la lógica de dimensiones ni el contrato de battlecard/hallazgos de Fase 1.

### Topes por corrida (decisión de Cal)

| Tope | Valor | Motivo |
|---|---|---|
| Posts por cuenta | 8 (los más recientes de la ventana) | Cubre el ritmo real de publicación de estas marcas (3-8/semana) |
| Videos por cuenta | 4 | El video es el paso caro (descarga + transcripción + N frames) |
| Frames por video | Muestreo parejo a lo largo del video, máx. 6 | "Transcripción + varios frames": captura la secuencia visual sin costo lineal en duración |
| Duración de video | Se saltea >5 min | Estas marcas publican formato corto; un video largo suele ser stream/webinar, baja densidad de intel por minuto procesado |

**Estimación realista por corrida semanal: 20-40 minutos.** Es un cron semanal + on-demand ocasional, no un hot path.

### Archivos

- `research-competencia-social.ts` (nuevo) — scraping y extracción de posts por plataforma.
- `research-competencia-media.ts` (nuevo) — descarga, `ffmpeg` (audio + frames), y análisis vía `analyzePhoto`/`transcribeAudio`.
- `research-competencia-entities.ts` — `EntityConfig` suma `instagram?`, `tiktok?`, `facebook?`, `x?` (arrays de handles).
- `research-competencia-sources.ts` — orquesta las fuentes sociales junto a las de Fase 1.
- `research-competencia-agent.ts` — `MechanicalFacts` suma `socialText`; el prompt reconoce RRSS como fuente citable (URL del post como `fuente`).
- ~~`~/.claude/config/cookie-jar-domains.json` — se agregan `instagram.com`, `tiktok.com`, `facebook.com`, `x.com`~~ — **no se tocó, ver Addendum punto 2.** `x.com`/`instagram.com` ya estaban ahí desde antes (otro flujo); `facebook.com`/`tiktok.com` nunca entraron.
- `research-competencia-cookies.ts` (nuevo, no listado en la versión original de esta sección) — lectura directa de Safari, lista de dominios propia (`SOCIAL_DOMAINS`), fail-closed sin FDA.
- `fetch-as-user.ts` (endurecido, no listado en la versión original de esta sección) — `isPrivateMessagingUrl()`, ver Addendum punto 3.
- `scripts/research-competencia-now.ts`, `scripts/research-competencia-env.ts`, `scripts/research-competencia-notify.ts` (nuevos) — el script standalone, validación de env vars, y envío por @ClaudeCalbot.
- `launchd/com.cal.jano-research-competencia.plist` (nuevo) — cron semanal, creado sin instalar.

### Manejo de fallas

Tres niveles de aislamiento, para que nada tumbe una corrida completa:

- **Por post**: un video roto o una imagen que no descarga no corta el resto de los posts de esa cuenta.
- **Por cuenta**: una cuenta bloqueada o con markup cambiado no corta las demás cuentas de la entidad.
- **Por entidad**: ya existe en Fase 1 — una entidad que falla no corta la corrida. Se sumó un
  **deadline de 8 minutos por entidad** para el scraping social (no estaba en la versión original
  de este spec, agregado en la implementación) — techo del peor caso, para que una entidad con
  varios handles y videos lentos no se coma buena parte del presupuesto de la corrida entera.

Facebook y TikTok detectan automatización de forma más agresiva que Instagram y X. Si una plataforma deja de rendir, degrada a `null` y queda registrado en las notas de la corrida — no se rompe nada ni se inventa contenido.

---

## Riesgos

- **Cuentas personales de Cal prestando cookies** podrían marcarse por actividad automatizada. Mitigado con 1 visita por cuenta por corrida, sin scroll infinito ni paginación, mismo perfil headless que ya corre en producción para `guardarReferenciaDiseno` sin incidentes.
- **Facebook/TikTok pueden bloquear pese a cookies válidas.** Aceptado: degradan a `null` sin romper la corrida. Si resulta sistemático, se evalúa en su momento (no se construye workaround por adelantado).
- **Costo y duración por corrida** — acotado por los topes de arriba; revisable si en la práctica queda corto o largo.
- **Fragilidad estructural** (los 4 sitios cambian markup seguido) — aislada por los 3 niveles de try/catch.
- **Sin verificar contra las páginas reales (2026-09-03).** Los 4 scrapers están testeados solo contra fixtures — nunca corrieron contra Instagram/TikTok/Facebook/X en vivo. Facebook y X en particular dependen de selectores DOM (`article`/`[role="article"]`) escritos con criterio, no confirmados. La primera corrida real es la primera prueba de humo end-to-end.

## Fuera de alcance

- Métricas de engagement (likes, comentarios, shares) — solo contenido, igual que Fase 1 no captura métricas de ninguna fuente.
- Comentarios de usuarios en los posts — es otra fuente (voz del cliente), no comunicación de la marca; se evalúa aparte si hace falta.
- Historias/stories efímeras — requieren polling frecuente para no perderlas, incompatible con un cron semanal.
