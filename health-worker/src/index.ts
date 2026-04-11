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

    return new Response('Health Data Worker. POST /ingest to add data, GET /summary or /trend to query.', { status: 404 })
  },
}
