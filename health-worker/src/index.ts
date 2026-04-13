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
    // Format: { data: { metrics: [{ name, units, data: [{ date, qty, ... }] }] } }
    if (url.pathname === '/ingest' && request.method === 'POST') {
      try {
        const body = await request.json() as any
        const metricGroups = body.data?.metrics ?? body.metrics
        if (!Array.isArray(metricGroups)) {
          return new Response(JSON.stringify({ error: 'Expected metrics array', keys: Object.keys(body) }), { status: 400 })
        }

        const stmt = env.DB.prepare(
          'INSERT OR IGNORE INTO health_metrics (metric, value, unit, date, timestamp) VALUES (?, ?, ?, ?, ?)'
        )

        const SLEEP_FIELDS = ['totalSleep', 'deep', 'rem', 'core', 'awake'] as const
        const batch: ReturnType<typeof stmt.bind>[] = []

        for (const group of metricGroups) {
          const name: string = group.name
          const unit: string = group.units ?? ''
          const points: any[] = group.data ?? []

          for (const p of points) {
            const date = (p.date ?? '').slice(0, 10)
            const ts = p.date ?? new Date().toISOString()

            if (name === 'sleep_analysis') {
              // Expand sleep into sub-metrics
              for (const field of SLEEP_FIELDS) {
                if (p[field] != null) {
                  batch.push(stmt.bind(`sleep_${field}`, Number(p[field]), 'hr', date, ts))
                }
              }
            } else {
              batch.push(stmt.bind(name, Number(p.qty ?? p.value ?? 0), unit, date, ts))
            }
          }
        }

        // D1 batch limit is 500 statements
        for (let i = 0; i < batch.length; i += 500) {
          await env.DB.batch(batch.slice(i, i + 500))
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

    return new Response('Health Data Worker. POST /ingest to add data, GET /summary or /trend to query.', { status: 404 })
  },
}
