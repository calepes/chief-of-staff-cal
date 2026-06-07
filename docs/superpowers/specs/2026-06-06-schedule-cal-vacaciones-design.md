# Schedule CAL — Tool de Vacaciones para Jano y Vesta

**Fecha:** 2026-06-06  
**Estado:** Aprobado  
**Alcance:** Jano + Vesta + mcp-servers/shared

---

## Contexto

Cal tiene una base de datos "Schedule CAL" en Notion que centraliza su agenda personal y de viajes. Las entradas de vacaciones se identifican por `Tipo = "Vacaciones"` (multi_select). Ni Jano ni Vesta pueden consultarla actualmente desde Telegram.

**BD:** Schedule CAL  
**Data Source ID:** `f66c31e7-a4c1-4b6e-9f65-c28ecaf50ce3`  
**URL Notion:** `https://app.notion.com/p/31216e379b6c4f1f9ac1bc792c27f0d5`

---

## Objetivo

Exponer dos tools a Jano y Vesta para que puedan responder preguntas como:
- "¿Cuántos días de vacaciones me quedan este año?"
- "¿Cuándo son mis próximas vacaciones?"
- "¿Qué está planeado para el viaje de julio?"

---

## Arquitectura

### Patrón de compartición cross-agent

Sigue el patrón establecido de `vuelos-naabol-format.ts`:

```
mcp-servers/shared/ntn.ts          ← fuente de verdad (callNtn)
    ↓ copia manual al editar
Jano/daemon-v2/src/shared/ntn.ts
Vesta/daemon-v2/src/shared/ntn.ts
(futuros agentes: copiar igual)
```

Cuando se edita `callNtn` en el futuro, actualizar `mcp-servers/shared/ntn.ts` y sincronizar las copias de cada agente.

### Estructura de archivos

```
mcp-servers/shared/
  ntn.ts                          ← NUEVO — callNtn cross-agent

Jano/daemon-v2/src/
  shared/
    ntn.ts                        ← NUEVO — copia de mcp-servers/shared/ntn.ts
    vuelos-naabol-format.ts       (existente)
  tools/
    schedule-cal.ts               ← NUEVO
    books.ts                      ← MODIFICADO — import callNtn desde ../shared/ntn.js

Vesta/daemon-v2/src/
  shared/
    ntn.ts                        ← NUEVO — copia de mcp-servers/shared/ntn.ts
  tools/
    schedule-cal.ts               ← NUEVO
```

---

## Módulo `ntn.ts`

```typescript
// mcp-servers/shared/ntn.ts
import { spawnSync } from "node:child_process";

export const NTN_BIN = "/opt/homebrew/bin/ntn";

export interface NtnResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export function callNtn(
  path: string,
  opts: { method?: "POST" | "PATCH" | "DELETE"; body?: unknown } = {}
): NtnResult {
  const args = ["api"];
  if (opts.method) args.push("-X", opts.method);
  args.push(path);
  if (opts.body !== undefined) args.push("-d", JSON.stringify(opts.body));

  const result = spawnSync(NTN_BIN, args, { encoding: "utf8", timeout: 15_000 });

  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout).trim() };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch {
    return { ok: true, data: result.stdout.trim() };
  }
}
```

**Cambio en `books.ts`:** eliminar la definición interna de `callNtn` y `NTN_BIN`, reemplazar por `import { callNtn, NTN_BIN } from "../shared/ntn.js"`. No cambia ninguna firma externa.

---

## Módulo `schedule-cal.ts`

### Constantes

```typescript
export const SCHEDULE_CAL_DS = "f66c31e7-a4c1-4b6e-9f65-c28ecaf50ce3";
```

### Tipos

```typescript
export interface VacacionEntry {
  pageId: string;
  url: string;
  name: string;
  fecha?: { start: string; end?: string };        // Fecha (date range)
  status?: string;                                 // Status: Not started | In progress | Done | Canceled
  clase?: string;                                  // Clase: Hito | Plan | Viaje
  tipo?: string[];                                 // multi_select (incluye "Vacaciones")
  anoVacaciones?: string;                          // Año Vacaciones: "2024 - 2025" etc.
  diasVacas?: number;                              // D. Vacas (rollup)
  ciudad?: string;                                 // Ciudad (relation display)
  pais?: string;                                   // Pais (rollup)
  pptoUsd?: number;                                // Ppto US$ (formula)
  registroVacaciones?: boolean;                    // checkbox
}

export interface VacacionDetail extends VacacionEntry {
  blocks?: string;  // contenido de página concatenado (text plano de bloques)
}
```

### Función `listVacaciones`

- Llama `v1/data_sources/{SCHEDULE_CAL_DS}/query`
- Filtro base: `Tipo` multi_select contains `"Vacaciones"`
- Filtros opcionales: `anoVacaciones` (select equals), `status`
- Devuelve array de `VacacionEntry` con formato HTML listo para Telegram

### Función `getVacacionDetail`

- Llama `v1/pages/{pageId}` para propiedades
- Llama `v1/blocks/{pageId}/children` para bloques
- Extrae texto plano de bloques (paragraph, heading, bulleted_list_item, numbered_list_item, to_do)
- Devuelve `VacacionDetail` con `blocks` concatenado (máx 3000 chars)

---

## Tools registradas en los agentes

### `listVacaciones`
```
Consulta las vacaciones de Cal en Schedule CAL (Notion).
Filtros opcionales: año (ej. "2025 - 2026"), status.
Devuelve lista con nombre, fechas, días disponibles, ciudad/país, presupuesto.
Llamar cuando Cal pregunte por sus vacaciones, días disponibles, viajes planeados,
o quiera revisar el plan de vacaciones.
```
Args: `{ year?: string, status?: "Not started"|"In progress"|"Done"|"Canceled" }`

### `getVacacionDetail`
```
Obtiene detalle completo de una entrada de vacaciones en Schedule CAL:
propiedades + contenido de la página (notas, itinerario, checklist).
Llamar cuando Cal pregunte por el contenido específico de unas vacaciones,
quiera ver el itinerario, o cuando listVacaciones no tenga suficiente detalle.
```
Args: `{ pageId: string }`

---

## Output format (HTML — Telegram)

### listVacaciones — ejemplo

```
🏖️ <b>Vacaciones 2025 - 2026</b> (2 entradas)

✈️ <b>Vacaciones Lima</b>
📅 15 jul – 22 jul · 7 días
📍 Lima, Perú · 💰 $580
Estado: Not started
<a href="https://notion.so/...">Ver en Notion →</a>

🏔️ <b>Fin de año Santa Cruz</b>
📅 27 dic – 2 ene
Estado: In progress
<a href="...">Ver en Notion →</a>
```

### getVacacionDetail — ejemplo

```
📋 <b>Vacaciones Lima</b>

📅 15 jul – 22 jul 2025
📍 Lima · Perú
💰 Presupuesto: $580
✅ Registro vacaciones: sí
Año: 2025 - 2026

<b>Notas:</b>
• Vuelo VVI → LIM 15/07 06:00
• Hotel Miraflores reservado
• Pendiente: sacar pasaportes niñas
```

---

## TOOL_MESSAGES (agent.ts en ambos agentes)

```typescript
"mcp__cos-tools__listVacaciones":     "🏖️ Consultando vacaciones...",
"mcp__cos-tools__getVacacionDetail":  "📋 Leyendo detalle de vacaciones...",
// Vesta usa "mcp__vesta-tools__*"
```

---

## Gotchas conocidos

- **ntn query:** usar `v1/data_sources/{ds_id}/query`, NO `v1/databases/{id}/query` (devuelve 400).
- **Filtro Tipo:** es `multi_select`, el filtro correcto es `{ property: "Tipo", multi_select: { contains: "Vacaciones" } }`.
- **D. Vacas** es un rollup — puede retornar `null` si la relación está vacía.
- **Bloques paginados:** `v1/blocks/{id}/children` retorna max 100 bloques. Para entradas de vacaciones el contenido es corto — sin paginación por ahora.
- **Fecha con rango:** el campo `Fecha` puede tener `start` y `end`. Mostrar rango cuando hay `end`.

---

## Criterios de éxito

- Jano y Vesta responden correctamente a "¿cuándo son mis vacaciones?" sin errores
- `callNtn` removido de `books.ts` e importado desde shared — sin regresión en tools de libros
- `ntn.ts` en `mcp-servers/shared/` como fuente de verdad documentada
- Build limpio en ambos agentes tras los cambios
