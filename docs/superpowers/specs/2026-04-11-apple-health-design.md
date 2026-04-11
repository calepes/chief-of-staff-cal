# Apple Health Integration — Design Spec

## Objetivo
Ver datos de salud (actividad, sueño, peso, frecuencia cardíaca) desde Telegram. Integrar en briefing diario /today como sección opcional.

## Requisitos
- iPhone con Apple Health
- App "Health Auto Export - JSON+CSV" (Lybron Sobers) con compra in-app para REST API export
- Cloudflare Worker + D1 para almacenar data

## Arquitectura

```
Health Auto Export (iPhone)
  → POST cada 4h a Worker
  → Worker valida y guarda en D1
  → Cal pregunta "cómo dormí" o /today
  → Claude consulta Worker API
  → Responde con resumen formateado
```

## Componentes

### 1. Health Auto Export (iPhone)
Configurar automated export:
- Format: JSON
- Endpoint: `https://health.carlos-cb4.workers.dev/ingest`
- Intervalo: cada 4 horas
- Métricas: pasos, calorías activas, distancia, sueño, peso, frecuencia cardíaca, ejercicios

### 2. Cloudflare Worker (`health`)
**Rutas:**

`POST /ingest`
- Recibe JSON de Health Auto Export
- Valida con API key (header `X-Health-Key`)
- Parsea métricas y guarda en D1
- Responde 200 OK

`GET /summary?date=2026-04-11`
- Retorna resumen del día: pasos, calorías, sueño, peso, FC
- Usado por Claude para responder preguntas

`GET /trend?metric=steps&days=7`
- Retorna tendencia de una métrica en los últimos N días
- Para "cómo va mi semana"

### 3. D1 Schema

```sql
CREATE TABLE health_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric TEXT NOT NULL,        -- 'steps', 'sleep', 'weight', 'heart_rate', 'calories', 'distance'
  value REAL NOT NULL,
  unit TEXT NOT NULL,           -- 'count', 'hours', 'kg', 'bpm', 'kcal', 'km'
  date TEXT NOT NULL,           -- '2026-04-11'
  timestamp TEXT NOT NULL,      -- ISO 8601 completo
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_metric_date ON health_metrics(metric, date);
```

### 4. Integración con Claude

No hay acciones mecánicas — todo pasa por el LLM.

**Triggers naturales:**
- "cómo dormí" / "sueño" → GET /summary?date=hoy, sección sueño
- "pasos hoy" / "actividad" → GET /summary?date=hoy, sección actividad
- "salud semana" / "tendencia" → GET /trend?metric=all&days=7
- "peso" → GET /trend?metric=weight&days=30

**Integración en /today:**
Agregar sección opcional al briefing:

```
🏥 Salud
- Sueño: 7.2h (objetivo: 7h) ✅
- Pasos ayer: 8,432 (objetivo: 8,000) ✅
- FC reposo: 62 bpm
- Peso: 78.5 kg (tendencia: -0.3 esta semana)
```

Solo aparece si hay data disponible del día/ayer.

### 5. `.env` del Worker
```
HEALTH_API_KEY=xxx  # Para validar POSTs del iPhone
```

### 6. Seguridad
- POST /ingest protegido con API key en header
- GET endpoints protegidos con la misma key o un Bearer token
- Data almacenada en D1 (encriptada at rest por Cloudflare)

## Setup inicial
1. Deploy Worker + crear D1 database en Cloudflare
2. Instalar Health Auto Export en iPhone
3. Configurar automated export al Worker con API key
4. Verificar que data llega a D1
5. Probar "cómo dormí" en Telegram

## Testing
1. Simular POST /ingest con data de prueba → verificar D1
2. GET /summary → verificar resumen correcto
3. "Cómo dormí" en Telegram → Claude consulta y responde
4. /today → verificar sección salud incluida
