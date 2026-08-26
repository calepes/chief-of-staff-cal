export interface RegisterCodexUsageInput {
  remainingPct: number;
  resetAt: string;
}

export async function registerCodexUsage(
  input: RegisterCodexUsageInput,
  opts: { url: string; secret: string },
) {
  if (!opts.url || !opts.secret) {
    return { error: "Codex Usage no está configurado" };
  }

  const res = await fetch(`${opts.url.replace(/\/$/, "")}/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.secret}`,
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Codex Usage ${res.status}: ${JSON.stringify(body)}`);
  return body;
}
