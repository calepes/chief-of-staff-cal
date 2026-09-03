# Spec: Research y monitoreo de competencia — Fase 2 (RRSS multimodal)

**Fecha:** 2026-09-02
**Estado:** Aprobado por Cal

---

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

Reusa tres piezas ya probadas en producción dentro del daemon — no se construye nada de cero:

| Pieza existente | Qué aporta |
|---|---|
| `cookie-jar.ts` (Cookie Broker) | Cookies logueadas por dominio, desde el KV neutral |
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
- `~/.claude/config/cookie-jar-domains.json` — se agregan `instagram.com`, `tiktok.com`, `facebook.com`, `x.com` (ninguno choca con `DENY_PATTERNS`, que solo bloquea banca/mail).

### Manejo de fallas

Tres niveles de aislamiento, para que nada tumbe una corrida completa:

- **Por post**: un video roto o una imagen que no descarga no corta el resto de los posts de esa cuenta.
- **Por cuenta**: una cuenta bloqueada o con markup cambiado no corta las demás cuentas de la entidad.
- **Por entidad**: ya existe en Fase 1 — una entidad que falla no corta la corrida.

Facebook y TikTok detectan automatización de forma más agresiva que Instagram y X. Si una plataforma deja de rendir, degrada a `null` y queda registrado en las notas de la corrida — no se rompe nada ni se inventa contenido.

---

## Riesgos

- **Cuentas personales de Cal prestando cookies** podrían marcarse por actividad automatizada. Mitigado con 1 visita por cuenta por corrida, sin scroll infinito ni paginación, mismo perfil headless que ya corre en producción para `guardarReferenciaDiseno` sin incidentes.
- **Facebook/TikTok pueden bloquear pese a cookies válidas.** Aceptado: degradan a `null` sin romper la corrida. Si resulta sistemático, se evalúa en su momento (no se construye workaround por adelantado).
- **Costo y duración por corrida** — acotado por los topes de arriba; revisable si en la práctica queda corto o largo.
- **Fragilidad estructural** (los 4 sitios cambian markup seguido) — aislada por los 3 niveles de try/catch.

## Fuera de alcance

- Métricas de engagement (likes, comentarios, shares) — solo contenido, igual que Fase 1 no captura métricas de ninguna fuente.
- Comentarios de usuarios en los posts — es otra fuente (voz del cliente), no comunicación de la marca; se evalúa aparte si hace falta.
- Historias/stories efímeras — requieren polling frecuente para no perderlas, incompatible con un cron semanal.
