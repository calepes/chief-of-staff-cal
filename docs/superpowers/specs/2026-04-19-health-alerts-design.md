# Health Alerts Reactivas — Diseño (4.3)

**Fecha:** 2026-04-19
**Status:** Aprobado
**Fase:** 4.3 (CoS Proactivo)

## Goal
Convertir el Health worker de fuente pasiva de datos en disparador de alertas accionables: sueño insuficiente, pasos atrasados, sedentarismo, HRV degradada, falta de daylight.

## Arquitectura
**Reusa el heartbeat engine.** Cada alerta es un nuevo `~/.claude/heartbeat-tasks/health-*.md` invocado por `heartbeat.sh` cada 30min. No se agrega infraestructura nueva — solo configuración.

Justificación (vs reactive en el worker):
- Heartbeat ya agrupa ALERTs por prioridad → un mensaje vs spam
- HRV/sueño no necesitan latencia <1min
- Sedentarismo "real-time" no es realista con Health Auto Export (no manda continuo)
- Cero infra nueva

## Componentes

### 1. Cinco checks `.md` nuevos

| Archivo | Schedule | Prioridad | Threshold | Mensaje |
|---|---|---|---|---|
| `health-sleep.md` | morning-wake | high | `sleep_totalSleep < 6h` anoche | "Anoche dormiste {N}h {M}min. Considera siesta o cama temprano hoy." |
| `health-steps-evening.md` | evening | medium | `step_count < 6000` hoy a las 6pm | "Vas en {N} pasos. Te faltan {M} para 8k. Tienes 2-3h." |
| `health-sedentary.md` | business-hours | low | `apple_stand_hour == 0` en últimas 2h | "Llevas 2h sin levantarte. Stand 1 min." |
| `health-hrv-weekly.md` | weekly-monday-am | medium | HRV semana actual < 80% del promedio últimas 4 semanas | "HRV bajó {N}% esta semana. Considera bajar intensidad o dormir más." |
| `health-daylight.md` | late-afternoon | low | `time_in_daylight < 15min` hoy | "Solo {N}min de daylight hoy. Hay 1-2h de sol — sal a caminar." |

`midday-steps.md` (ya existente, alerta si <3000 al mediodía) queda sin cambios.

### 2. Extensión `should_run()` en `heartbeat.sh`

Agregar 5 schedule values al case statement:

```bash
morning-wake)    # 7-9am cualquier día
  [[ "$hour" -ge 7 && "$hour" -lt 9 ]] && return 0 ;;
evening)         # 17-19h cualquier día
  [[ "$hour" -ge 17 && "$hour" -lt 19 ]] && return 0 ;;
business-hours)  # 10-19h Lun-Vie (dow 1-5)
  [[ "$hour" -ge 10 && "$hour" -lt 19 && "$dow" -ge 1 && "$dow" -le 5 ]] && return 0 ;;
weekly-monday-am) # Lunes 8-9am
  [[ "$dow" == 1 && "$hour" -ge 8 && "$hour" -lt 9 ]] && return 0 ;;
late-afternoon)  # 17-18h cualquier día
  [[ "$hour" -ge 17 && "$hour" -lt 18 ]] && return 0 ;;
```

Donde `dow=$(date +%u)` (1=lunes, 7=domingo).

### 3. State file anti-spam

**Path:** `~/.claude/state/health-alerts-YYYY-MM-DD.json`
**Formato:**
```json
{
  "sleep_low": true,
  "steps_evening": true,
  "sedentary": true,
  "hrv_degraded": true,
  "daylight_low": true
}
```

**Lifecycle:**
- Cada check lee el archivo de hoy antes de evaluar
- Si la key del check ya existe → responde `HEARTBEAT_OK` (no realerta)
- Tras alertar, agrega su key con `jq` o crea el archivo si no existe
- Limpieza: `find ~/.claude/state -name 'health-alerts-*.json' -mtime +7 -delete` desde `heartbeat.sh` al inicio (idempotente)

**Keys reservadas por check:**
- `sleep_low` (health-sleep.md)
- `steps_evening` (health-steps-evening.md)
- `sedentary` (health-sedentary.md) — nota: este puede tener sentido alertar más de 1 vez/día en el futuro, pero v1 = 1 vez
- `hrv_degraded` (health-hrv-weekly.md)
- `daylight_low` (health-daylight.md)

## Flujo por check

1. `heartbeat.sh` evalúa `should_run` y arranca `claude -p` con el contenido del `.md`
2. Claude ejecuta `curl` al Health worker (`/summary` o `/trend`) usando `HEALTH_API_KEY`
3. Lee `~/.claude/state/health-alerts-$(date +%Y-%m-%d).json` (si existe)
4. Si la key del check existe → responde `HEARTBEAT_OK`
5. Evalúa threshold contra data del worker:
   - **Worker caído / data faltante** → `HEARTBEAT_OK` (no spam con errores)
   - **Threshold no se cumple** → `HEARTBEAT_OK`
   - **Threshold se cumple** → escribe state file (agrega key) y responde `ALERT\n<mensaje>`
6. heartbeat.sh recibe ALERT, lo agrupa con otros del mismo run y manda a Telegram

## Edge cases

| Caso | Comportamiento |
|---|---|
| Health worker devuelve 5xx | `HEARTBEAT_OK` |
| `HEALTH_API_KEY` no está en env | `HEARTBEAT_OK` |
| `/summary` no tiene la métrica del check | `HEARTBEAT_OK` (no hay data hoy) |
| HRV con <4 semanas de baseline | `HEARTBEAT_OK` (no se puede comparar) |
| State file corrupto / no parseable | tratar como vacío (alerta normal, sobreescribe) |
| Sedentarismo en weekend | `business-hours` no dispara (dow ≠ 1-5) |

## Testing

Cada `.md` incluye al final:

```html
<!-- Test scenario: <descripción> -->
```

Para probar manualmente:

```bash
# Forzar un check específico (ignora schedule, fuerza ejecución)
~/.claude/hooks/heartbeat.sh --only health-sleep --dry-run

# Limpiar state de hoy (re-disparar todos los checks)
rm -f ~/.claude/state/health-alerts-$(date +%Y-%m-%d).json
```

## Observabilidad

- Logs: `~/.claude/logs/heartbeat.log` (ya existente)
- Status: `~/.claude/hooks/heartbeat-status.sh` (sin cambios — los nuevos checks aparecen automáticos)

## Entregables

- 5 archivos `.md` en `~/.claude/heartbeat-tasks/` + copias en `heartbeat-tasks/` del repo
- Edit a `~/.claude/hooks/heartbeat.sh` (función `should_run`) + copia en `hooks/` del repo
- Edit a `~/.claude/hooks/heartbeat.sh` para limpieza de state files >7 días
- Update `CLAUDE.md` (sección Heartbeat checks actuales)
- Update `BACKLOG.md` (4.3 marcado done)
- Update `CHANGELOG.md` (entrada 2026-04-19)
- ~3-4 commits

## Rollout

1. Implementar checks uno por uno con `--dry-run` para validar
2. Cargar al engine (sin recargar launchd — heartbeat.sh lee `~/.claude/heartbeat-tasks/*.md` dinámicamente)
3. Esperar 24h y revisar `~/.claude/logs/heartbeat.log` para detectar false positives
4. Ajustar thresholds si Cal recibe ruido

## No-goals

- No reactive push desde el worker (descartado en brainstorming)
- No alertas multi-vez por día (state file fuerza 1x — se puede flexibilizar después)
- No actualización de Notion ni dashboards — solo Telegram
- No coaching plan ni metas configurables — los thresholds son hardcoded en cada `.md` (modificable editando el archivo)
