# Feedbin daily report — clasificación completa + agrupado por tema + marcar leído por botón

Fecha: 2026-09-05
Pedido de Cal, brainstorming en sesión interactiva.

## Contexto

`checkFeedbinDailyReport` (`daemon-v2/src/proactive/feedbin-daily-report.ts`), el cron diario
08:00 que ya existe, clasifica no leídos de Feedbin en "abrir" / "saltar" usando el perfil de
temas (`topics-profile.md`, regenerado semanalmente por `topics-profile-refresh.ts`). Hoy tiene
un techo (`MAX_TO_CLASSIFY = 60`) que solo mira los más recientes — con un backlog de 363 (caso
real de hoy), 303 quedan sin tocar. Cal pidió tres cambios relacionados:

1. Clasificar TODO el backlog no leído, no solo los últimos 60.
2. Agrupar los artículos recomendados por tema (usando el conocimiento del perfil).
3. Para los de baja relevancia, poder confirmar "marcar como leído" vía un botón del bot — nunca
   auto-ejecutar sin ese tap.

Investigación previa en la misma sesión ya resolvió dos piezas que este diseño da por sentadas:
- Los links a artículos van a `feedbinEntryUrl(id)` (`https://feedbin.com/entries/{id}`), no a
  la URL original — abrirlos marca la entrada como leída del lado de Feedbin (verificado en
  vivo). Ya está en producción, sin cambios en este diseño.
- El perfil de temas semanal (`topics-profile.md`) ya usa citas verificables `[ID]` resueltas
  contra fuentes reales — mismo principio de "nunca confiar en una URL/ID que escriba el modelo
  sin verificar contra la lista real" aplica acá.

## Decisiones (validadas en brainstorming)

- **Cadencia:** el cron SIEMPRE clasifica el backlog completo actual, todos los días — no solo
  "lo nuevo desde ayer". Si Cal no confirma un grupo, vuelve a aparecer al día siguiente. El
  número baja únicamente cuando confirma.
- **Fuente de agrupado:** grupos LIBRES por día (el modelo arma las categorías que mejor calcen
  con el batch de HOY), usando `topics-profile.md` como contexto de intereses — NO las ~15
  categorías fijas del perfil semanal como casillero a rellenar.
- **Granularidad del botón:** un botón de "marcar leído" POR GRUPO temático, no uno solo para
  todo — permite confirmar unos sí y otros no.
- **Tope de "para abrir" en días grandes (validado con mockup visual, artifact
  `94cdf63e-f89e-4720-9d18-2450c2ecda73`):** se muestran TODOS los grupos detectados, sin tope de
  cantidad de grupos — cada grupo lista un máximo de 5 artículos con link + `...y N más` si es
  más grande. Se descartó la alternativa de mostrar unos pocos grupos completos y colapsar el
  resto (infla el mensaje cuando un solo tema es grande — verificado visualmente con datos reales
  de hoy: el grupo "Apple" con 35 artículos volvía el mockup de esa alternativa notablemente más
  largo).

## Arquitectura

```
cron diario 08:00 (mismo horario que hoy)
  │
  ├─ 1. Fetch: getAllUnreadEntries + getSubscriptions + getTaggings (sin cambios)
  │
  ├─ 2. Clasificar TODO el backlog en lotes de 60 (nuevo — hoy corta en 60)
  │     → N llamadas a Haiku (una por lote), cada una devuelve [{id, decision: abrir|saltar}]
  │     → se acumulan en dos arrays: entradasAbrir[], entradasSaltar[]
  │     → un lote que falla se loguea y se excluye de ambos arrays (no aborta el resto)
  │
  ├─ 3. Agrupar por tema — 2 llamadas a Haiku separadas, cada una sobre el conjunto COMPLETO
  │     (no por lote — agrupar necesita ver todo junto para formar grupos coherentes):
  │     → agruparPorTema(entradasAbrir, perfil)   → grupos libres
  │     → agruparPorTema(entradasSaltar, perfil)  → grupos libres, sesión aparte
  │     → si CUALQUIERA de las dos falla, esa sección cae a lista plana sin grupos ni botones
  │       (la otra sección sigue con su tratamiento normal si le fue bien)
  │
  ├─ 4. Guardar en KV los grupos de "marcar leído" con sus entryIds reales (para que el botón
  │     sepa qué marcar sin mandar IDs en el callback_data — ver "Estado" abajo)
  │
  └─ 5. Render + enviar:
        - "✅ Para abrir": TODOS los grupos, cada uno con top-5 links + "...y N más"
        - "⏭️ Marcar leído": hasta 6 grupos con botón propio (los más grandes primero) +
          1 botón final "✅ Marcar el resto (N)" si sobra algo — total ≤7 botones, 4 filas
```

## Estado (KV) y callback

Mismo mecanismo que journal/backlog/tareas/learnings (`cf-kv.ts`, `tryAcquireLock`/proposal
pattern):

```
key:   jano:feedbin-report:{reportId}
value: { groups: [{ id: "g1", label: "Rumores hardware Apple", entryIds: [123, 456, ...] }, ...] }
TTL:   7 días
```

`reportId` corto (nanoid) va en el `callback_data`: `fbr:mark:{reportId}:{groupId}` — nunca IDs
reales (violaría el límite de 64 bytes de Telegram). Callbacks `fbr:*` son HEAVY (leen/escriben
KV + llaman a Feedbin), van arriba del catch-all de "Heavy callbacks legacy" en `index.ts`, con
el mismo lock anti-doble-tap que journal/backlog/tareas.

**Al tocar un botón de grupo:**
1. `answerCallbackQuery` inmediato.
2. Adquirir lock (`tryAcquireLock`).
3. `DELETE /v2/unread_entries.json` con los `entryIds` de ESE grupo.
4. Editar la MISMA tarjeta (nunca mensaje nuevo): la línea del grupo pasa a
   `✅ ~~Rumores hardware Apple~~ — marcado (66)`, y su botón se reemplaza por `↩️ Deshacer`
   (TTL 10 min) — los demás botones de otros grupos quedan intactos e independientes.
5. `↩️ Deshacer` → `POST /v2/unread_entries.json` con los mismos IDs (Feedbin permite volver a
   marcar como no leído) → la línea y el botón `✅` vuelven a su estado normal.

"Marcar el resto" es el mismo mecanismo, con los `entryIds` de todo lo que no entró en los
grupos con botón propio.

**Reportes de días distintos conviven sin conflicto:** cada corrida del cron genera un
`reportId` nuevo (mensaje nuevo, KV nuevo). Si Cal no confirma el de ayer y llega el de hoy, el
botón de ayer sigue siendo válido durante su TTL — tocarlo marca esas entradas igual (Feedbin no
rechaza marcar como leído algo ya leído), simplemente reduce de más los grupos del día siguiente.
No hace falta invalidar reportes viejos al generar uno nuevo.

## Manejo de errores

- Fetch inicial falla: igual que hoy, loguea y corta sin mandar nada.
- Un lote de classify falla: se loguea (`batch_classify_failed`, con índice), esas entradas
  quedan sin clasificar y se excluyen de los totales — el resto de lotes sigue.
- El agrupado (abrir o saltar) falla: esa sección cae a lista plana sin grupos ni botones; la
  otra sección no se ve afectada.
- Envío del mensaje falla: mismo fallback de 3 niveles que ya usa `topics-profile-refresh.ts`
  hoy (Rich Message → HTML clásico → texto plano vía `sendCronMessage`).
- `DELETE /unread_entries.json` falla al tocar un botón: la tarjeta se edita con un error breve
  en esa línea (`⚠️ No se pudo marcar — reintentar`) + botón `🔄 Reintentar`, sin tocar el resto
  de la tarjeta.
- KV de la propuesta venció (>7 días) y tocan un botón viejo: `⏳ Esto expiró, corré el reporte
  de nuevo`, sin teclado.

## Testing

Puro y testeable sin red (siguiendo el estilo ya establecido en `topics-profile-refresh.test.ts`
y `feedbin-daily-report.test.ts`):
- `buildGroupingPrompt` (nuevo) y `parseGroupingResult` (nuevo, mismo patrón que
  `parseClassifyResult` ya existente).
- Render de "para abrir" (todos los grupos, cap de 5 + "...y N más").
- Selección de los ≤6 grupos con botón + "el resto" para "marcar leído".
- Loop de batches de classify: un lote que falla no aborta los siguientes.
- Fallback a lista plana si el agrupado falla.
- Flujo completo del callback: marcar → editar tarjeta → deshacer → re-editar.

Nada de esto llama a Feedbin/Haiku real en tests.

## Fuera de alcance (explícitamente, no pedido)

- No se cambia el horario del cron (sigue 08:00).
- No se toca la sección de "para abrir" con lógica de deshacer/confirmación — sigue siendo
  puramente informativa (links directos), sin botones.
- No hay tope de CANTIDAD de grupos para "para abrir" (solo tope de items mostrados por grupo) —
  validado que el volumen de caracteres no es un problema real incluso en un día grande.
