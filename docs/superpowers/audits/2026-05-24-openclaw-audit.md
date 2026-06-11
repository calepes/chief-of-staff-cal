# Auditoría OpenClaw — Fases 1-5

**Fecha:** 2026-05-24
**Contexto:** Story Atenea `35cc4876-09dd-8167-bc86-c64e6106952c`

---

## Estado por Fase

### Fase 1 — Hooks básicos ✅ OPERATIVO

| Hook | Script | Registrado en settings.json |
|------|--------|-----------------------------|
| SessionStart (fecha + recordatorios) | `session-start-context.sh` | ✅ |
| Stop (notificación Telegram) | `stop-telegram-notify.sh` | ✅ |
| PreCompact (snapshot transcript) | `pre-compact-snapshot.sh` | ✅ |
| PostToolUse Notion (audit log) | `notion-audit.sh` | ✅ |
| PostToolUse (captura errores) | `learn-error.sh` | ✅ |
| PreToolUse (seguridad) | `security-guard.sh` | ✅ |
| SessionStart (sync .mcp.json) | `sync-mcp-json.sh` | ✅ |

**Discrepancia:** BACKLOG dice `stop-telegram-notify.sh` "NO registrado — dispara en toda sesión CLI" pero SÍ está en `settings.json`. Decisión de registrarlo tomada en algún momento sin actualizar el BACKLOG.

**Pendientes del BACKLOG ya resueltos (actualizar):**
- `pre-compact-snapshot.sh` — BACKLOG dice "revisar y registrar si sigue siendo válido" → ya está registrado
- `notion-audit.sh` — idem

---

### Fase 1.5 — Outlook Calendar + Cron cache ✅ OPERATIVO

- `com.claude.outlook-cache` activo en launchctl (exit 0, no PID = corrió exitoso)
- Script `refresh-outlook-cache.sh` ✅

---

### Fase 2 — Cron Jobs ⚠️ PARCIAL

| Cron | Plist | Estado | Notas |
|------|-------|--------|-------|
| Nightly report 22:00 | `com.claude.nightly-report` | ✅ Activo | |
| Eisenhower Dom 21:00 | `com.claude.eisenhower-weekly` | ✅ Activo | |
| Briefings 5am | `com.claude.daily-briefings` | ❌ `.disabled` | Intencional — on-demand via `runBriefing` tool |

Los briefings están deshabilitados intencionalmente (movidos a on-demand via `runBriefing`), pero el plist `.disabled` sigue en `~/Library/LaunchAgents/` junto con un backup `.bak-2026-05-08`. Limpiar.

---

### Fase 3 — Heartbeat ✅ OPERATIVO

- `com.claude.heartbeat` activo en launchctl (exit 0)
- 12 heartbeat tasks activas en `heartbeat-tasks/`

**Inventario real de heartbeat-tasks:**
```
health-bodycomp-weekly.md   health-daylight.md          health-hrv-weekly.md
health-sedentary.md         health-sleep.md              health-steps-evening.md
health-strength-weekly.md   incomplete-tasks.md          midday-steps.md
overdue-reminders.md        usage-evening.md             usage-morning.md
```

**Discrepancias vs documentación:**
- `overdue-tasks.md` → el archivo real se llama `overdue-reminders.md` (CLAUDE.md y BACKLOG usan el nombre viejo)
- `flight-checkin.md` → removido del heartbeat (movido al daemon) ✅ correcto
- `usage-morning.md` y `usage-evening.md` → **NO documentadas en CLAUDE.md** (2 tasks sin doc)

---

### Fase 4 — Webhooks ✅ OPERATIVO (scope reducido)

- 7 health alerts via heartbeat ✅
- Gmail webhook ~~descartado~~ ✅
- GitHub PRs ~~descartado~~ ✅
- Notion changes ~~descartado~~ ✅

---

### Fase 5 — Auto-mejora ⚠️ PARCIAL

| Componente | Estado | Notas |
|-----------|--------|-------|
| Learnings captura individual | ✅ | Hook `learn-error.sh` registrado |
| Learnings batch nocturno 21:55 | ❌ | `com.claude.extract-learnings` en `disabled-2026-04-21/` — nunca fue cargado |
| Learnings sync semanal Dom 21:00 | ❌ | `com.claude.sync-learnings` en `disabled-2026-04-21/` — nunca fue cargado |
| Morning builds 22:30 | ✅ | `com.cal.jano-morning-build` activo (renombrado del original) |
| Skill detector Dom 21:30 | ❌ | `com.claude.skill-detector` en `disabled-2026-04-21/` — BACKLOG dice "cargado" (incorrecto) |
| Proactive ideas 9am/14/19h | ⏸️ | En `disabled-2026-04-21/` — bloqueado por falta de tokens X/Threads |

**Estado real del sistema de learnings:**
- Captura individual funciona (hook `learn-error.sh` + skill `/learn`)
- El batch nocturno `extract-learnings.sh` que consolida learnings de transcripts **NO corre automáticamente** — el plist nunca fue cargado
- El sync semanal al repo `docs/learnings/` **NO corre** — plist no cargado

---

## Inventario de Plists

### Activos en launchctl
```
com.claude.cli-update          exit 0  (activo)
com.claude.eisenhower-weekly   exit 0  (activo)
com.claude.heartbeat           exit 0  (activo)
com.claude.nightly-report      exit 0  (activo)
com.claude.outlook-cache       exit 0  (activo)
com.cal.jano-morning-build     exit 1  (activo — exit 1 indica falla reciente o sin correr aún hoy)
com.cal.cos-agent-v2           PID 37930  (daemon Jano, corriendo)
com.cal.family-agent-v2        PID 83207  (daemon Vesta, corriendo)
com.calepes.pecunia-agent      PID 5951   (daemon Pecunia, corriendo)
com.cal.atenea.daemon          PID 32028  (daemon Atenea, corriendo)
```

### En ~/Library/LaunchAgents/ pero NO en launchctl
```
com.claude.daily-briefings.plist.disabled    (deshabilitado intencionalmente)
com.claude.daily-briefings.plist.bak-2026-05-08
com.claude.eisenhower-weekly.plist.bak-2026-05-08  (backup)
com.claude.heartbeat.plist.bak-2026-05-08          (backup)
com.claude.nightly-report.plist.bak-2026-05-08     (backup)
```

### En disabled-2026-04-21/ (pausados desde migración)
```
com.cal.cos-health-check.plist   → OBSOLETO (reemplazado por heartbeat engine)
com.claude.extract-learnings.plist  → NO cargado (learnings batch)
com.claude.morning-build.plist   → OBSOLETO (reemplazado por com.cal.jano-morning-build)
com.claude.proactive-ideas.plist → BLOQUEADO (tokens X/Threads pendientes)
com.claude.skill-detector.plist  → NO cargado (requiere decisión)
com.claude.sync-learnings.plist  → NO cargado (learnings sync semanal)
```

### En disabled-2026-04-29/ (migración a v2)
```
com.cal.cos-agent.plist  → OBSOLETO (reemplazado por com.cal.cos-agent-v2)
```

---

## Deuda Técnica

### D1 — Learnings batch sin cargar
`extract-learnings` y `sync-learnings` plists nunca fueron cargados. El sistema de auto-mejora opera con captura individual pero sin el pipeline completo (nightly consolidation + weekly sync al repo).

**Acción sugerida:** Decidir con Cal si activar o archivar. El batch nocturno añade valor pero requiere verificar que el script `extract-learnings.sh` esté adaptado al claude CLI path actual (`~/.npm-global/bin/claude`).

### D2 — Skill detector documentado como activo pero no lo está
BACKLOG dice "Plist cargado 2026-04-20" pero `com.claude.skill-detector.plist` está en `disabled-2026-04-21/`. El detector nunca ha corrido en producción.

**Acción sugerida:** Verificar si el script apunta al claude CLI correcto antes de cargar.

### D3 — Plists obsoletos sin limpiar
`com.cal.cos-health-check` y `com.claude.morning-build` en disabled-2026-04-21/ son obsoletos (reemplazados). `com.cal.cos-agent` en disabled-2026-04-29/ también.

**Acción sugerida:** Eliminar esos 3 archivos para reducir confusión.

### D4 — Backups .bak en LaunchAgents
4 archivos `.bak-2026-05-08` en `~/Library/LaunchAgents/`. No interfieren pero son ruido.

### D5 — Nombres desactualizados en docs
- `overdue-tasks.md` → nombre real: `overdue-reminders.md`
- BACKLOG menciona `flight-checkin.md` como heartbeat task → ya no existe en heartbeat-tasks/
- `stop-telegram-notify.sh`: docs dicen "NO registrado" → SÍ está registrado

### D6 — usage-morning.md y usage-evening.md sin documentar
Dos heartbeat tasks sin mención en CLAUDE.md ni BACKLOG.
