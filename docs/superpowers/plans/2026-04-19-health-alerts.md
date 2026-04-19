# Health Alerts Reactivas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar 5 alertas de salud al heartbeat engine (sueño, pasos PM, sedentarismo, HRV semanal, daylight) con anti-spam diario.

**Architecture:** Reusa el heartbeat engine de Fase 3. Cada alerta es un `~/.claude/heartbeat-tasks/health-*.md` con frontmatter (`schedule`, `priority`). State file diario en `~/.claude/state/health-alerts-YYYY-MM-DD.json` previene spam. Extensión a `should_run()` agrega 5 schedule values.

**Tech Stack:** bash, claude CLI headless (`claude -p`), Cloudflare Worker (Health, ya desplegado), jq, curl.

**Spec:** `docs/superpowers/specs/2026-04-19-health-alerts-design.md`

---

## File Structure

**Modify:**
- `~/.claude/hooks/heartbeat.sh` — agregar 5 schedule values + lógica de limpieza state files >7 días + bypass should_run cuando se usa `--only`
- `hooks/heartbeat.sh` (repo) — sincronizar
- `CLAUDE.md` — actualizar sección "Heartbeat checks actuales"
- `BACKLOG.md` — marcar 4.3 done
- `CHANGELOG.md` — entrada 2026-04-19 (tarde 2)

**Create:**
- `~/.claude/heartbeat-tasks/health-sleep.md` (+ copia en repo `heartbeat-tasks/`)
- `~/.claude/heartbeat-tasks/health-steps-evening.md` (+ copia en repo)
- `~/.claude/heartbeat-tasks/health-sedentary.md` (+ copia en repo)
- `~/.claude/heartbeat-tasks/health-hrv-weekly.md` (+ copia en repo)
- `~/.claude/heartbeat-tasks/health-daylight.md` (+ copia en repo)

---

## Task 1: Extender should_run() con 5 schedule values nuevos

**Files:**
- Modify: `~/.claude/hooks/heartbeat.sh:43-55`
- Sync: `/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/hooks/heartbeat.sh`

- [ ] **Step 1: Reemplazar función should_run**

Editar `~/.claude/hooks/heartbeat.sh`. Reemplazar el bloque actual:

```bash
# should_run <schedule> → exit 0 if should run now, 1 otherwise
should_run() {
  local schedule="$1"
  local hour
  hour=$(date +%H)
  case "$schedule" in
    every) return 0 ;;
    morning-only) (( 10#$hour < 12 )) && return 0 || return 1 ;;
    afternoon-only) (( 10#$hour >= 12 )) && return 0 || return 1 ;;
    midday-only) [[ "$hour" == "12" ]] && return 0 || return 1 ;;
    *) return 1 ;;
  esac
}
```

Por:

```bash
# should_run <schedule> → exit 0 if should run now, 1 otherwise
should_run() {
  local schedule="$1"
  local hour dow
  hour=$(date +%H)
  dow=$(date +%u)  # 1=Mon ... 7=Sun
  case "$schedule" in
    every) return 0 ;;
    morning-only) (( 10#$hour < 12 )) && return 0 || return 1 ;;
    afternoon-only) (( 10#$hour >= 12 )) && return 0 || return 1 ;;
    midday-only) [[ "$hour" == "12" ]] && return 0 || return 1 ;;
    morning-wake) (( 10#$hour >= 7 && 10#$hour < 9 )) && return 0 || return 1 ;;
    evening) (( 10#$hour >= 17 && 10#$hour < 19 )) && return 0 || return 1 ;;
    business-hours) (( 10#$hour >= 10 && 10#$hour < 19 && dow >= 1 && dow <= 5 )) && return 0 || return 1 ;;
    weekly-monday-am) [[ "$dow" == "1" ]] && (( 10#$hour >= 8 && 10#$hour < 9 )) && return 0 || return 1 ;;
    late-afternoon) (( 10#$hour >= 17 && 10#$hour < 18 )) && return 0 || return 1 ;;
    *) return 1 ;;
  esac
}
```

- [ ] **Step 2: Hacer que --only bypase should_run**

En `main()`, encontrar:

```bash
    if [[ -n "$ONLY_CHECK" && "$name" != "$ONLY_CHECK" ]]; then
      continue
    fi
    if ! should_run "$schedule"; then
      log "skip $name (schedule=$schedule)"
      continue
    fi
```

Reemplazar por:

```bash
    if [[ -n "$ONLY_CHECK" && "$name" != "$ONLY_CHECK" ]]; then
      continue
    fi
    if [[ -z "$ONLY_CHECK" ]] && ! should_run "$schedule"; then
      log "skip $name (schedule=$schedule)"
      continue
    fi
```

- [ ] **Step 3: Agregar limpieza de state files >7 días al inicio de main**

En `main()`, justo después del bloque de rotación de log (línea ~97), agregar:

```bash
  # Limpieza state files de health-alerts >7 días
  find "$STATE_DIR" -name 'health-alerts-*.json' -mtime +7 -delete 2>/dev/null || true
```

- [ ] **Step 4: Validar sintaxis**

```bash
bash -n ~/.claude/hooks/heartbeat.sh && echo OK
```

Expected: `OK`

- [ ] **Step 5: Probar should_run con --only sin disparar nada real**

Crear un check temporal de prueba:

```bash
mkdir -p /tmp/hb-test
cat > ~/.claude/heartbeat-tasks/_test-bypass.md <<'EOF'
---
name: _test-bypass
schedule: weekly-monday-am
priority: low
---
Responde EXACTAMENTE: HEARTBEAT_OK
EOF
~/.claude/hooks/heartbeat.sh --only _test-bypass --dry-run 2>&1 | tail -10
rm ~/.claude/heartbeat-tasks/_test-bypass.md
```

Expected: log muestra `run _test-bypass` (no `skip`), confirmando que --only bypassed should_run.

- [ ] **Step 6: Sincronizar al repo y commit**

```bash
cp ~/.claude/hooks/heartbeat.sh "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/hooks/heartbeat.sh"
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add hooks/heartbeat.sh
git commit -m "feat(heartbeat): 5 schedule values nuevos + bypass should_run con --only

- morning-wake (7-9am), evening (17-19h), business-hours (10-19h L-V),
  weekly-monday-am, late-afternoon
- --only ahora ignora should_run para facilitar testing
- Limpieza automática de state files health-alerts >7 días"
```

---

## Task 2: Check health-sleep.md (sueño bajo al despertar)

**Files:**
- Create: `~/.claude/heartbeat-tasks/health-sleep.md`
- Create: `/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/heartbeat-tasks/health-sleep.md`

- [ ] **Step 1: Crear el .md**

```bash
cat > ~/.claude/heartbeat-tasks/health-sleep.md <<'EOF'
---
name: health-sleep
schedule: morning-wake
priority: high
---

# Check sueño bajo

State file: `~/.claude/state/health-alerts-$(date +%Y-%m-%d).json`

Si la key `sleep_low` ya existe en el state file de hoy, responde EXACTAMENTE:
HEARTBEAT_OK

Si no existe, consulta el Health worker:

```
GET https://health.carlos-cb4.workers.dev/summary?date=YYYY-MM-DD&key=$HEALTH_API_KEY
```

donde YYYY-MM-DD es la fecha de HOY (zona horaria local de Cal). API key en variable HEALTH_API_KEY.

Busca la métrica `sleep_totalSleep` (unidad `hr`) en el array `metrics`. El valor representa horas dormidas anoche.

Reglas de decisión:
- Si la respuesta es 4xx/5xx, o la métrica no existe, o el valor está vacío → responde EXACTAMENTE: HEARTBEAT_OK
- Si `sleep_totalSleep >= 6` → responde EXACTAMENTE: HEARTBEAT_OK
- Si `sleep_totalSleep < 6` → primero actualiza el state file, luego responde con ALERT.

Para actualizar el state file (usa Bash):
```bash
STATE=~/.claude/state/health-alerts-$(date +%Y-%m-%d).json
mkdir -p ~/.claude/state
if [[ -f "$STATE" ]]; then
  jq '.sleep_low = true' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
else
  echo '{"sleep_low": true}' > "$STATE"
fi
```

Formato de mensaje (convierte horas decimales a Hh Mmin):
ALERT
😴 Anoche dormiste {H}h {M}min. Considera siesta o cama temprano hoy.

<!-- Test scenario: si Health Auto Export reporta <6h de sueño, alerta UNA vez en ventana 7-9am. Si ya alertó hoy, silencio. Si worker está caído, silencio. -->
EOF
```

- [ ] **Step 2: Verificar que el archivo es leído por heartbeat (parse)**

```bash
~/.claude/hooks/heartbeat.sh --only health-sleep --dry-run 2>&1 | grep -E "(run|skip) health-sleep"
```

Expected: línea `run health-sleep` (porque --only bypasea schedule).

- [ ] **Step 3: Sincronizar al repo y commit**

```bash
mkdir -p "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/heartbeat-tasks"
cp ~/.claude/heartbeat-tasks/health-sleep.md "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/heartbeat-tasks/health-sleep.md"
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add heartbeat-tasks/health-sleep.md
git commit -m "feat(heartbeat): check health-sleep (alerta si <6h al despertar)"
```

---

## Task 3: Check health-steps-evening.md (pasos atrasados al final del día)

**Files:**
- Create: `~/.claude/heartbeat-tasks/health-steps-evening.md`
- Create: `/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/heartbeat-tasks/health-steps-evening.md`

- [ ] **Step 1: Crear el .md**

```bash
cat > ~/.claude/heartbeat-tasks/health-steps-evening.md <<'EOF'
---
name: health-steps-evening
schedule: evening
priority: medium
---

# Check pasos atrasados (PM)

State file: `~/.claude/state/health-alerts-$(date +%Y-%m-%d).json`

Si la key `steps_evening` ya existe en el state file de hoy, responde EXACTAMENTE:
HEARTBEAT_OK

Si no existe, consulta el Health worker:

```
GET https://health.carlos-cb4.workers.dev/summary?date=YYYY-MM-DD&key=$HEALTH_API_KEY
```

donde YYYY-MM-DD es HOY. API key en variable HEALTH_API_KEY.

Busca la métrica `step_count`. El campo `total` es el acumulado del día.

Reglas:
- Worker caído / métrica ausente → HEARTBEAT_OK
- `step_count.total >= 6000` → HEARTBEAT_OK
- `step_count.total < 6000` → actualiza state y alerta.

Update state:
```bash
STATE=~/.claude/state/health-alerts-$(date +%Y-%m-%d).json
mkdir -p ~/.claude/state
if [[ -f "$STATE" ]]; then
  jq '.steps_evening = true' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
else
  echo '{"steps_evening": true}' > "$STATE"
fi
```

Formato (calcula faltante a 8000):
ALERT
🚶 Vas en {N} pasos. Te faltan {8000-N} para 8k. Tienes 2-3h.

<!-- Test scenario: a las 17-19h, si step_count<6000 alerta una vez. Si ya alertó, silencio. -->
EOF
```

- [ ] **Step 2: Verificar parse**

```bash
~/.claude/hooks/heartbeat.sh --only health-steps-evening --dry-run 2>&1 | grep "run health-steps-evening"
```

Expected: una línea con `run health-steps-evening`.

- [ ] **Step 3: Sincronizar y commit**

```bash
cp ~/.claude/heartbeat-tasks/health-steps-evening.md "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/heartbeat-tasks/health-steps-evening.md"
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add heartbeat-tasks/health-steps-evening.md
git commit -m "feat(heartbeat): check health-steps-evening (alerta si <6000 a las 17-19h)"
```

---

## Task 4: Check health-sedentary.md (sin levantarse 2h en horario laboral)

**Files:**
- Create: `~/.claude/heartbeat-tasks/health-sedentary.md`
- Create: `/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/heartbeat-tasks/health-sedentary.md`

- [ ] **Step 1: Crear el .md**

```bash
cat > ~/.claude/heartbeat-tasks/health-sedentary.md <<'EOF'
---
name: health-sedentary
schedule: business-hours
priority: low
---

# Check sedentarismo (sin stand_hour en últimas 2h)

State file: `~/.claude/state/health-alerts-$(date +%Y-%m-%d).json`

Si la key `sedentary` ya existe en el state file de hoy, responde EXACTAMENTE:
HEARTBEAT_OK

Si no existe, necesitas saber si Cal se levantó en las últimas 2 horas. La métrica `apple_stand_hour` se registra una vez por hora cuando Apple Health detecta movimiento.

Estrategia: consulta el trend de las últimas 24h y filtra por timestamp.

```
GET https://health.carlos-cb4.workers.dev/trend?metric=apple_stand_hour&days=1&key=$HEALTH_API_KEY
```

La respuesta tiene `data: [{date, total, unit}, ...]`. Cada `total` es el acumulado por día (no por hora). Esta query NO da granularidad por hora.

Workaround (v1): consulta `/summary?date=hoy` y compara con `/summary?date=ayer` para detectar si Cal está activo HOY. Si `apple_stand_hour.total` HOY es 0 después de las 12pm → probablemente sedentario o iPhone descargado.

Reglas:
- Worker caído / data faltante → HEARTBEAT_OK
- Hora actual < 12pm → HEARTBEAT_OK (muy temprano para conclusiones)
- `apple_stand_hour.total` HOY ≥ (hora_actual - 9) * 0.4 → HEARTBEAT_OK (proxy: ~24min de movimiento por hora despierta es saludable)
- Caso contrario → actualiza state y alerta.

Update state:
```bash
STATE=~/.claude/state/health-alerts-$(date +%Y-%m-%d).json
mkdir -p ~/.claude/state
if [[ -f "$STATE" ]]; then
  jq '.sedentary = true' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
else
  echo '{"sedentary": true}' > "$STATE"
fi
```

Formato:
ALERT
🏃 Llevas pocas horas activas hoy. Stand 1 min, camina 2-3min.

<!-- Test scenario: en horario laboral L-V, si apple_stand_hour acumulado es muy bajo vs hora del día, alerta una vez. Worker caído, weekend, o muy temprano → silencio. -->
EOF
```

- [ ] **Step 2: Verificar parse**

```bash
~/.claude/hooks/heartbeat.sh --only health-sedentary --dry-run 2>&1 | grep "run health-sedentary"
```

Expected: `run health-sedentary`.

- [ ] **Step 3: Sincronizar y commit**

```bash
cp ~/.claude/heartbeat-tasks/health-sedentary.md "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/heartbeat-tasks/health-sedentary.md"
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add heartbeat-tasks/health-sedentary.md
git commit -m "feat(heartbeat): check health-sedentary (proxy stand_hour vs hora del día)"
```

---

## Task 5: Check health-hrv-weekly.md (HRV degradada vs baseline 4 semanas)

**Files:**
- Create: `~/.claude/heartbeat-tasks/health-hrv-weekly.md`
- Create: `/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/heartbeat-tasks/health-hrv-weekly.md`

- [ ] **Step 1: Crear el .md**

```bash
cat > ~/.claude/heartbeat-tasks/health-hrv-weekly.md <<'EOF'
---
name: health-hrv-weekly
schedule: weekly-monday-am
priority: medium
---

# Check HRV degradada (lunes 8-9am)

State file: `~/.claude/state/health-alerts-$(date +%Y-%m-%d).json`

Si la key `hrv_degraded` ya existe en el state file de hoy, responde EXACTAMENTE:
HEARTBEAT_OK

Si no existe, consulta tendencia de HRV de las últimas 4 semanas:

```
GET https://health.carlos-cb4.workers.dev/trend?metric=heart_rate_variability&days=28&key=$HEALTH_API_KEY
```

Respuesta: `{ metric: "heart_rate_variability", days: 28, data: [{date, total, unit}, ...] }`.

Reglas:
- Worker caído / data vacía → HEARTBEAT_OK
- Si hay <14 días de data en las últimas 4 semanas → HEARTBEAT_OK (insuficiente para baseline confiable)
- Calcula:
  - `hrv_baseline` = promedio de los días 8-28 (las 3 semanas anteriores a esta)
  - `hrv_current` = promedio de los últimos 7 días
- Si `hrv_current >= hrv_baseline * 0.8` → HEARTBEAT_OK
- Si `hrv_current < hrv_baseline * 0.8` → calcula `pct = round((1 - hrv_current/hrv_baseline) * 100)`, actualiza state y alerta.

Update state:
```bash
STATE=~/.claude/state/health-alerts-$(date +%Y-%m-%d).json
mkdir -p ~/.claude/state
if [[ -f "$STATE" ]]; then
  jq '.hrv_degraded = true' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
else
  echo '{"hrv_degraded": true}' > "$STATE"
fi
```

Formato:
ALERT
❤️ HRV bajó {pct}% esta semana vs baseline 4-sem. Considera bajar intensidad o dormir más.

<!-- Test scenario: lunes 8-9am, si HRV semanal cayó >20% vs baseline 3-sem, alerta UNA vez. Si <14 días de data, silencio. Worker caído, silencio. -->
EOF
```

- [ ] **Step 2: Verificar parse**

```bash
~/.claude/hooks/heartbeat.sh --only health-hrv-weekly --dry-run 2>&1 | grep "run health-hrv-weekly"
```

Expected: `run health-hrv-weekly`.

- [ ] **Step 3: Sincronizar y commit**

```bash
cp ~/.claude/heartbeat-tasks/health-hrv-weekly.md "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/heartbeat-tasks/health-hrv-weekly.md"
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add heartbeat-tasks/health-hrv-weekly.md
git commit -m "feat(heartbeat): check health-hrv-weekly (HRV vs baseline 4 sem)"
```

---

## Task 6: Check health-daylight.md (poco tiempo al sol)

**Files:**
- Create: `~/.claude/heartbeat-tasks/health-daylight.md`
- Create: `/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/heartbeat-tasks/health-daylight.md`

- [ ] **Step 1: Crear el .md**

```bash
cat > ~/.claude/heartbeat-tasks/health-daylight.md <<'EOF'
---
name: health-daylight
schedule: late-afternoon
priority: low
---

# Check daylight bajo

State file: `~/.claude/state/health-alerts-$(date +%Y-%m-%d).json`

Si la key `daylight_low` ya existe en el state file de hoy, responde EXACTAMENTE:
HEARTBEAT_OK

Si no existe, consulta:

```
GET https://health.carlos-cb4.workers.dev/summary?date=YYYY-MM-DD&key=$HEALTH_API_KEY
```

donde YYYY-MM-DD es HOY.

Busca la métrica `time_in_daylight`. El `total` está en minutos (unidad `min` típicamente).

Reglas:
- Worker caído / métrica ausente → HEARTBEAT_OK
- `time_in_daylight.total >= 15` → HEARTBEAT_OK
- `time_in_daylight.total < 15` → actualiza state y alerta.

Update state:
```bash
STATE=~/.claude/state/health-alerts-$(date +%Y-%m-%d).json
mkdir -p ~/.claude/state
if [[ -f "$STATE" ]]; then
  jq '.daylight_low = true' "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
else
  echo '{"daylight_low": true}' > "$STATE"
fi
```

Formato:
ALERT
☀️ Solo {N}min de daylight hoy. Hay 1-2h de sol — sal a caminar.

<!-- Test scenario: a las 17-18h, si time_in_daylight<15min alerta una vez. Worker caído o métrica ausente, silencio. -->
EOF
```

- [ ] **Step 2: Verificar parse**

```bash
~/.claude/hooks/heartbeat.sh --only health-daylight --dry-run 2>&1 | grep "run health-daylight"
```

Expected: `run health-daylight`.

- [ ] **Step 3: Sincronizar y commit**

```bash
cp ~/.claude/heartbeat-tasks/health-daylight.md "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/heartbeat-tasks/health-daylight.md"
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add heartbeat-tasks/health-daylight.md
git commit -m "feat(heartbeat): check health-daylight (alerta si <15min al sol a las 17-18h)"
```

---

## Task 7: End-to-end smoke test

**Files:** ninguno modificado en esta task

- [ ] **Step 1: Listar checks activos**

```bash
~/.claude/hooks/heartbeat-status.sh
```

Expected: en "Checks activos:" aparecen los 5 nuevos health-* + los 4 existentes (overdue-tasks, flight-checkin, incomplete-tasks, midday-steps) = 9 total.

- [ ] **Step 2: Probar cada check con --dry-run forzando ejecución**

```bash
for check in health-sleep health-steps-evening health-sedentary health-hrv-weekly health-daylight; do
  echo "=== $check ==="
  ~/.claude/hooks/heartbeat.sh --only "$check" --dry-run 2>&1 | tail -5
done
```

Expected: cada uno termina con alguna línea de log (`alert <name>` o `ok <name>`), o muestra el bloque DRY RUN si hay alerta. Ningún `error <name>`.

- [ ] **Step 3: Verificar state file (si alguno alertó)**

```bash
ls -la ~/.claude/state/health-alerts-*.json 2>&1
cat ~/.claude/state/health-alerts-$(date +%Y-%m-%d).json 2>/dev/null | jq .
```

Expected: si hubo alertas, hay archivo JSON con keys correspondientes (`sleep_low`, `steps_evening`, etc).

- [ ] **Step 4: Probar que la segunda corrida del mismo check NO realerta**

Si el state file existe con alguna key:

```bash
# Suponiendo que health-daylight alertó y escribió daylight_low en el state
~/.claude/hooks/heartbeat.sh --only health-daylight --dry-run 2>&1 | tail -3
```

Expected: log muestra `ok health-daylight` (HEARTBEAT_OK por anti-spam), NO bloque DRY RUN.

- [ ] **Step 5: Limpiar state de test**

```bash
rm -f ~/.claude/state/health-alerts-$(date +%Y-%m-%d).json
```

Nota: si Cal usa el sistema en producción inmediatamente, los checks reales del día pueden volver a disparar.

---

## Task 8: Documentar en CLAUDE.md / BACKLOG.md / CHANGELOG.md

**Files:**
- Modify: `/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/CLAUDE.md`
- Modify: `/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/BACKLOG.md`
- Modify: `/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal/CHANGELOG.md`

- [ ] **Step 1: Update CLAUDE.md "Heartbeat checks actuales"**

Reemplazar la línea actual:

```
- **Heartbeat checks actuales:** `overdue-tasks.md` (every/high), `flight-checkin.md` (every/high), `incomplete-tasks.md` (morning-only/medium), `midday-steps.md` (midday-only/medium)
```

Por:

```
- **Heartbeat checks actuales:** `overdue-tasks.md` (every/high), `flight-checkin.md` (every/high), `incomplete-tasks.md` (morning-only/medium), `midday-steps.md` (midday-only/medium), `health-sleep.md` (morning-wake/high), `health-steps-evening.md` (evening/medium), `health-sedentary.md` (business-hours/low), `health-hrv-weekly.md` (weekly-monday-am/medium), `health-daylight.md` (late-afternoon/low)
- **Heartbeat anti-spam:** state file diario `~/.claude/state/health-alerts-YYYY-MM-DD.json` previene realerta de health-* (1 alerta por tipo por día). Limpieza automática de archivos >7 días al inicio de cada run.
```

Usar Edit tool con `old_string` y `new_string`.

- [ ] **Step 2: Update BACKLOG.md — marcar 4.3 como done**

Reemplazar:

```
- [ ] 4.3 Health alertas → "dormiste <6h", "no caminaste hoy" (worker ya existe, agregar lógica)
```

Por:

```
- [x] 4.3 Health alertas reactivas → 5 checks en heartbeat (sleep, steps-evening, sedentary, hrv-weekly, daylight) con state file anti-spam diario. Spec: `2026-04-19-health-alerts-design.md`. Plan: `2026-04-19-health-alerts.md` (2026-04-19)
```

- [ ] **Step 3: Update CHANGELOG.md — agregar entrada**

Insertar al inicio (después del header `# CHANGELOG — Chief of Staff Cal`):

```markdown
## 2026-04-19 (tarde 2)

### Fase 4.3 — Health alertas reactivas
- **Feature**: 5 checks de salud en `~/.claude/heartbeat-tasks/`: `health-sleep.md` (sueño <6h al despertar, morning-wake/high), `health-steps-evening.md` (pasos <6000 a las 17-19h, medium), `health-sedentary.md` (poca actividad acumulada vs hora del día, business-hours L-V/low), `health-hrv-weekly.md` (HRV semana <80% vs baseline 4 sem, lunes 8am/medium), `health-daylight.md` (daylight <15min a las 17-18h, low)
- **Feature**: Extensión `should_run()` en `~/.claude/hooks/heartbeat.sh` con 5 schedule values nuevos: `morning-wake` (7-9am), `evening` (17-19h), `business-hours` (10-19h L-V), `weekly-monday-am`, `late-afternoon` (17-18h)
- **Feature**: Anti-spam vía state file diario `~/.claude/state/health-alerts-YYYY-MM-DD.json`. Cada check escribe su key tras alertar y revisa antes de re-disparar. Limpieza automática de archivos >7 días
- **Feature**: Flag `--only` ahora bypassa `should_run` para facilitar testing fuera de la ventana de ejecución
- **Spec/Plan**: `docs/superpowers/specs/2026-04-19-health-alerts-design.md`, `docs/superpowers/plans/2026-04-19-health-alerts.md`

```

- [ ] **Step 4: Commit docs**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Chief of Staff Cal"
git add CLAUDE.md BACKLOG.md CHANGELOG.md
git commit -m "docs: 4.3 Health alertas reactivas (5 checks heartbeat)"
```

---

## Task 9: Notificar a Cal

**Files:** ninguno

- [ ] **Step 1: Enviar mensaje Telegram resumiendo qué se hizo**

Texto sugerido (chat_id 94137698):

```
✅ 4.3 Health alertas — implementado y desplegado

5 checks nuevos activos en el heartbeat:
😴 health-sleep — alerta si dormiste <6h (7-9am, high)
🚶 health-steps-evening — alerta si <6000 pasos a las 6pm (medium)
🏃 health-sedentary — alerta si poca actividad acumulada en horario laboral (low, L-V)
❤️ health-hrv-weekly — alerta si HRV semanal <80% baseline 4 sem (lunes 8am)
☀️ health-daylight — alerta si <15min de sol a las 5pm (low)

Anti-spam: 1 alerta por tipo por día. State en ~/.claude/state/health-alerts-YYYY-MM-DD.json

Para probar uno manual:
~/.claude/hooks/heartbeat.sh --only health-sleep --dry-run

Para resetear (re-disparar):
rm ~/.claude/state/health-alerts-$(date +%Y-%m-%d).json
```

Usar el tool `mcp__plugin_telegram_telegram__reply` con `chat_id: "94137698"`.

---

## Notas finales

- Los thresholds están hardcoded en cada `.md`. Si Cal pide cambiar (ej: 8h en vez de 6h para sleep), editar el `.md` correspondiente y sincronizar al repo.
- Si en una semana Cal reporta ruido (false positives), ajustar thresholds editando los `.md`.
- Sedentarismo es el más débil (no hay granularidad por hora). Si no funciona bien, una opción futura es recibir push del iPhone con timestamps (Health Auto Export soporta intervalos personalizados).
