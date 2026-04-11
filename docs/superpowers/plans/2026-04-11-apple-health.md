# Apple Health Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receive Apple Health data via a Cloudflare Worker, store in D1, and surface health metrics in Telegram conversations and daily briefings.

**Architecture:** Health Auto Export (iOS app) sends JSON data to a Cloudflare Worker on a schedule. Worker validates, parses, and stores in D1. Claude queries the Worker API when the user asks about health or during /today briefings.

**Tech Stack:** Cloudflare Workers + D1, Health Auto Export (iOS), Bun/TypeScript

---

### Task 1: Create Cloudflare Worker + D1

**Files:**
- Create: `health-worker/src/index.ts`
- Create: `health-worker/wrangler.toml`
- Create: `health-worker/package.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "health-worker",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create D1 database**

```bash
cd health-worker
npx wrangler d1 create health-data
```

Note the returned database ID.

- [ ] **Step 3: Create wrangler.toml**

```toml
name = "health"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "health-data"
database_id = "TBD_FROM_STEP_2"
```

- [ ] **Step 4: Create D1 schema migration**

```bash
mkdir -p migrations
```

Create `health-worker/migrations/0001_create_tables.sql`:

```sql
CREATE TABLE health_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  date TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_metric_date ON health_metrics(metric, date);
```

Apply:
```bash
npx wrangler d1 execute health-data --file=migrations/0001_create_tables.sql
```

- [ ] **Step 5: Create src/index.ts**

```ts
interface Env {
  DB: D1Database
  HEALTH_API_KEY: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Auth check
    const apiKey = request.headers.get('X-Health-Key') ?? url.searchParams.get('key')
    if (apiKey !== env.HEALTH_API_KEY) {
      return new Response('Unauthorized', { status: 401 })
    }

    // POST /ingest — receive health data from Health Auto Export
    if (url.pathname === '/ingest' && request.method === 'POST') {
      try {
        const body = await request.json() as any
        const metrics = body.data?.metrics ?? body.metrics ?? body
        if (!Array.isArray(metrics)) {
          return new Response('Expected metrics array', { status: 400 })
        }

        const stmt = env.DB.prepare(
          'INSERT INTO health_metrics (metric, value, unit, date, timestamp) VALUES (?, ?, ?, ?, ?)'
        )

        const batch = metrics.map((m: any) => {
          const date = (m.date ?? m.startDate ?? new Date().toISOString()).slice(0, 10)
          const ts = m.date ?? m.startDate ?? new Date().toISOString()
          return stmt.bind(m.name ?? m.metric, Number(m.qty ?? m.value), m.units ?? m.unit ?? '', date, ts)
        })

        if (batch.length > 0) {
          await env.DB.batch(batch)
        }

        return new Response(JSON.stringify({ inserted: batch.length }), {
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (e) {
        return new Response(`Error: ${e}`, { status: 500 })
      }
    }

    // GET /summary?date=2026-04-11 — daily summary
    if (url.pathname === '/summary') {
      const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10)
      const rows = await env.DB.prepare(
        `SELECT metric, SUM(value) as total, unit, COUNT(*) as samples
         FROM health_metrics
         WHERE date = ?
         GROUP BY metric`
      ).bind(date).all()

      return new Response(JSON.stringify({ date, metrics: rows.results }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // GET /trend?metric=steps&days=7 — trend over time
    if (url.pathname === '/trend') {
      const metric = url.searchParams.get('metric') ?? 'steps'
      const days = parseInt(url.searchParams.get('days') ?? '7')
      const rows = await env.DB.prepare(
        `SELECT date, SUM(value) as total, unit
         FROM health_metrics
         WHERE metric = ? AND date >= date('now', '-' || ? || ' days')
         GROUP BY date
         ORDER BY date`
      ).bind(metric, days).all()

      return new Response(JSON.stringify({ metric, days, data: rows.results }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response('Not found', { status: 404 })
  },
}
```

- [ ] **Step 6: Set secret and deploy**

```bash
cd health-worker
npx wrangler secret put HEALTH_API_KEY
npm run deploy
```

- [ ] **Step 7: Test with curl**

```bash
# Ingest test data
curl -X POST https://health.carlos-cb4.workers.dev/ingest \
  -H "X-Health-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"name":"steps","qty":8432,"units":"count","date":"2026-04-11T23:59:00Z"},{"name":"sleep","qty":7.2,"units":"hours","date":"2026-04-11T06:30:00Z"}]'

# Query summary
curl "https://health.carlos-cb4.workers.dev/summary?date=2026-04-11&key=YOUR_KEY"
```

Expected: `{"date":"2026-04-11","metrics":[{"metric":"steps","total":8432,...},{"metric":"sleep","total":7.2,...}]}`

- [ ] **Step 8: Commit**

```bash
cd ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal
git add health-worker/
git commit -m "feat: Cloudflare Worker for Apple Health data ingestion"
```

---

### Task 2: Configure Health Auto Export on iPhone

- [ ] **Step 1: Install and configure Health Auto Export**

1. Open Health Auto Export on iPhone
2. Go to Automations → Add Automation
3. Configure:
   - Type: REST API
   - URL: `https://health.carlos-cb4.workers.dev/ingest`
   - Method: POST
   - Headers: `X-Health-Key: YOUR_KEY`
   - Format: JSON
   - Metrics: Steps, Sleep Analysis, Weight, Heart Rate, Active Energy, Walking + Running Distance
   - Interval: Every 4 hours
4. Enable automation

- [ ] **Step 2: Verify data arrives**

Wait for next automation run, then:
```bash
curl "https://health.carlos-cb4.workers.dev/summary?date=$(date +%Y-%m-%d)&key=YOUR_KEY"
```

---

### Task 3: Document Health Integration for Claude

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add health section to CLAUDE.md**

```markdown
### Apple Health
- **Worker:** `https://health.carlos-cb4.workers.dev`
- **API Key:** en `~/.claude/channels/telegram/.env` como `HEALTH_API_KEY`
- **Endpoints:**
  - `GET /summary?date=YYYY-MM-DD` — resumen del día
  - `GET /trend?metric=X&days=N` — tendencia
- **Métricas:** steps, sleep, weight, heart_rate, calories, distance
- **Uso en /today:** incluir sección 🏥 Salud si hay data disponible
- **Triggers naturales:** "cómo dormí", "pasos hoy", "salud semana", "peso"
```

- [ ] **Step 2: Add HEALTH_API_KEY to plugin .env**

```bash
echo 'HEALTH_API_KEY=YOUR_KEY' >> ~/.claude/channels/telegram/.env
echo 'HEALTH_WORKER_URL=https://health.carlos-cb4.workers.dev' >> ~/.claude/channels/telegram/.env
```

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/Claude\ Projects/Personal/Agents/Chief\ of\ Staff\ Cal
git add CLAUDE.md
git commit -m "docs: add Apple Health integration to CLAUDE.md"
```

---

### Task 4: Test End-to-End from Telegram

- [ ] **Step 1: Ask "cómo dormí" in Telegram**

Expected: Claude fetches /summary, extracts sleep metric, responds with formatted summary.

- [ ] **Step 2: Ask "pasos hoy"**

Expected: Step count for today.

- [ ] **Step 3: Ask "salud semana"**

Expected: 7-day trend of all metrics.

- [ ] **Step 4: Run /today and verify health section appears**

Expected: Briefing includes 🏥 Salud section with available metrics.
