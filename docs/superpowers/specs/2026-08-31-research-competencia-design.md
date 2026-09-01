# Spec: Research y monitoreo de competencia — Yape Bolivia

**Fecha:** 2026-08-31
**Estado:** Aprobado por Cal

---

## Propósito

Flujo agéntico que investiga periódicamente (y bajo demanda) a los competidores de Yape en Bolivia — cambios de producto, movimientos de estrategia/GTM, y señales de hiring — y deja un registro histórico consultable en Notion. No es solo un research puntual: guarda snapshot del estado actual de cada competidor y un changelog de qué cambió entre corridas.

## Trigger

- **Cron semanal automático** (lunes 7am), timeframe fijo = últimos 7 días.
- **On-demand desde Telegram** (Jano): Cal pide "corre el research de los últimos N días" y arranca en el momento.
- **On-demand en sesión interactiva**: slash command `/research-competencia [timeframe] [entidades opcional]`.

Los tres triggers llaman a la **misma función/script** — mismo patrón que `kpi-card-yape` (una implementación, cron + on-demand).

---

## Entidades a trackear (6)

Tres son pares banco+billetera tratados como **una sola entidad** en Notion — el research cubre ambas superficies (app, sitio, LinkedIn del banco y de la billetera), pero todo hallazgo se loguea bajo la misma página, sin distinguir de qué lado vino:

1. Banco Sol / Altoke
2. Banco Ganadero / Yolo Pago
3. Banco Económico / Zaz
4. Takenos
5. Meru
6. Peso App

## Dimensiones de research

Todo hallazgo se clasifica en una de estas cuatro:

- **Producto** — versión de app, features nuevas, ratings/reviews, pricing/tarifas publicadas en su sitio
- **Estrategia** — alianzas, comunicados oficiales, posicionamiento, cambios de T&C
- **GTM** — campañas, promos, canales, lanzamientos
- **Hiring** — roles nuevos abiertos en LinkedIn, posts institucionales de LinkedIn

---

## Fuentes

### Fase 1 (MVP — sin login, sin browser automation)

| Fuente | Cómo | Cubre |
|---|---|---|
| App Store + Google Play | Scraper no oficial (paquete npm tipo `app-store-scraper` / `google-play-scraper`) — versión, changelog, rating | Producto |
| Sitio web propio | WebFetch, diff de contenido visible (no HTML crudo) contra el snapshot guardado | Producto, GTM |
| Prensa/web | WebSearch acotado al timeframe | Estrategia, GTM |
| LinkedIn | WebSearch (jobs + posts de la empresa) — no scraping directo, LinkedIn bloquea sin sesión | Hiring, Estrategia |

### Fase 2 (después, si Fase 1 no alcanza)

Instagram, Facebook, X, TikTok — vía Playwright + cookies logueadas (mismo patrón que el skill `guardar-referencia-diseno`). Se agrega solo si el research de Fase 1 se queda corto; no es parte del build inicial.

---

## Estructura en Notion

**Página padre:** "Yape Bolivia" (`1f3c487609dd800a97e7c11870f3bd3f`). Verificado 2026-08-31: ambas integraciones tienen acceso (interactiva "Notion CLI" y bot "Claude CoS" que usa Jano) — el cron semanal puede escribir ahí sin compartir nada extra.

**DB "Competencia — Cambios"** (historial, append-only): una fila por hallazgo.
- Competidor (relation a la entidad)
- Dimensión (select: Producto / Estrategia / GTM / Hiring)
- Fecha
- Descripción
- Fuente/link

**6 páginas de estado** (una por entidad): snapshot actual por dimensión (última versión de app, pricing vigente, roles abiertos, etc.). Se sobreescribe en cada corrida y es la baseline contra la que se diffea la corrida siguiente.

**DB "Informe Análisis Competencia"** (nueva, una página por corrida): agrupa el informe completo de cada corrida en un solo lugar, en vez de tener que filtrar "Cambios" por fecha.
- Fecha, timeframe cubierto, entidades incluidas
- Conteo de hallazgos por dimensión
- Cuerpo de la página: informe completo formateado (hallazgos de esa corrida agrupados por entidad/dimensión, o "sin novedades" si no hubo nada)
- Relation a las filas de "Competencia — Cambios" que generó esa corrida

---

## Flujo de una corrida

1. Recibe timeframe (default: últimos 7 días si viene del cron) y lista de entidades (default: las 6).
2. Por cada entidad: lee su página de estado en Notion como baseline, corre research en las fuentes de Fase 1.
3. Compara contra la baseline; lo nuevo/cambiado dentro del timeframe se redacta como hallazgo y se clasifica en una dimensión. Un filtro de relevancia descarta ruido (cambios triviales de HTML, texto sin sustancia).
4. Escribe las filas nuevas en la DB de Cambios + actualiza la página de estado de cada entidad tocada + crea la página de esa corrida en "Informe Análisis Competencia" (con el informe completo, aunque no haya hallazgos).
5. Devuelve resumen ejecutivo corto (con link a la página del informe completo).
6. **Primera corrida por entidad:** no hay baseline → todo se registra como "estado inicial" en la página de estado, sin generar filas de "cambio" (evita ruido falso del arranque).

### Entrega según trigger

- **Cron semanal:** resumen corto por Telegram (vía notificaciones a Cal) + detalle completo queda en Notion.
- **On-demand (Telegram o interactivo):** responde en el mismo canal donde se pidió; Notion se actualiza igual.

---

## Riesgos y mitigaciones

- **LinkedIn/RRSS con cobertura limitada vía WebSearch** (sin login, Google indexa parcial) → aceptable en Fase 1; Fase 2 lo refuerza con cookies si hace falta.
- **Falsos positivos en diff de sitio web** (cambios triviales de HTML/maquetación) → comparar solo texto visible relevante + filtro de relevancia antes de loggear como hallazgo.
- **Costo de tokens** de la corrida (6 entidades × 4 fuentes, research en vivo) → aceptable: 1 vez por semana + on-demand ocasional, no es un poll continuo.
- **Scraper de app stores no oficial puede romperse** si cambia la estructura de la store → liviano de arreglar cuando pase, no bloquea el resto del flujo.

---

## Fuera de alcance (por ahora)

- RRSS (Instagram/Facebook/X/TikTok) — Fase 2, no en el build inicial.
- Alertas en tiempo real / polling continuo — el cron es semanal, no hay monitoreo intra-semana.
- Comparación automática entre competidores (benchmarking) — este flujo registra y clasifica hallazgos por entidad; el análisis cruzado queda para que Cal lo pida manualmente sobre los datos ya guardados.
