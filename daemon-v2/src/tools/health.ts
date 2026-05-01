const HEALTH_BASE = "https://health.carlos-cb4.workers.dev";
const TIMEOUT_MS = 8000;

export interface HealthDeps {
  apiKey: string;
}

export async function getHealthSummary(deps: HealthDeps, date?: string): Promise<unknown> {
  const url = `${HEALTH_BASE}/summary?key=${encodeURIComponent(deps.apiKey)}${date ? `&date=${encodeURIComponent(date)}` : ""}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`health summary failed: ${res.status}`);
  return await res.json();
}

export async function getHealthTrend(deps: HealthDeps, metric: string, days: number): Promise<unknown> {
  const url = `${HEALTH_BASE}/trend?metric=${encodeURIComponent(metric)}&days=${days}&key=${encodeURIComponent(deps.apiKey)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`health trend failed: ${res.status}`);
  return await res.json();
}

export async function getWorkouts(deps: HealthDeps, days = 7, category?: string): Promise<unknown> {
  let url = `${HEALTH_BASE}/workouts/summary?days=${days}&key=${encodeURIComponent(deps.apiKey)}`;
  if (category) url += `&type=${encodeURIComponent(category)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`health workouts failed: ${res.status}`);
  return await res.json();
}
