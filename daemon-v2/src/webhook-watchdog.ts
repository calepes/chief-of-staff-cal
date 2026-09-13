type Log = (event: Record<string, unknown>) => void;

class TelegramApiError extends Error {}

interface EnsureTelegramWebhookDeps {
  botToken: string;
  expectedUrl: string;
  secret: string;
  fetchFn?: typeof fetch;
  markHealthy: () => Promise<void>;
  markBroken: () => Promise<void>;
  log: Log;
}

export function networkErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("name" in error && error.name === "TimeoutError") return "TIMEOUT";
  const cause = "cause" in error ? error.cause : undefined;
  if (!cause || typeof cause !== "object" || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "invalid";
  }
}

export async function ensureTelegramWebhook(deps: EnsureTelegramWebhookDeps): Promise<void> {
  if (!deps.secret || !deps.expectedUrl) return;
  const fetchFn = deps.fetchFn ?? fetch;
  const startedAt = Date.now();
  let operation = "getWebhookInfo";

  try {
    const infoResponse = await fetchFn(`https://api.telegram.org/bot${deps.botToken}/getWebhookInfo`, {
      signal: AbortSignal.timeout(10_000),
    });
    const info = (await infoResponse.json()) as { ok: boolean; result?: { url?: string }; description?: string };
    if (!infoResponse.ok || !info.ok) throw new TelegramApiError(`getWebhookInfo failed: ${infoResponse.status} ${info.description ?? ""}`.trim());

    const currentUrl = info.result?.url ?? "";
    if (currentUrl === deps.expectedUrl) {
      await deps.markHealthy().catch((err) => deps.log({ msg: "webhook_health_kv_error", err: String(err) }));
      return;
    }

    deps.log({
      msg: "webhook_drift_detected",
      currentOrigin: origin(currentUrl),
      expectedOrigin: origin(deps.expectedUrl),
    });
    await deps.markBroken().catch((err) => deps.log({ msg: "webhook_health_kv_error", err: String(err) }));
    operation = "setWebhook";
    const restoreResponse = await fetchFn(`https://api.telegram.org/bot${deps.botToken}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: deps.expectedUrl,
        secret_token: deps.secret,
        drop_pending_updates: false,
        allowed_updates: ["message", "callback_query", "edited_message"],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await restoreResponse.json()) as { ok: boolean; description?: string };
    deps.log(data.ok
      ? { msg: "webhook_restored" }
      : { msg: "webhook_restore_failed", err: data.description });
  } catch (err) {
    const apiFailure = err instanceof TelegramApiError || err instanceof SyntaxError;
    deps.log({
      msg: apiFailure ? "webhook_api_probe_failed" : "webhook_network_probe_failed",
      err: String(err),
      errorCode: networkErrorCode(err),
      operation,
      host: "api.telegram.org",
      durationMs: Date.now() - startedAt,
    });
  }
}

export function createWebhookWatchdogTick(check: () => Promise<void>, log: Log): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight) {
      log({ msg: "webhook_watchdog_tick_skipped" });
      return;
    }
    inFlight = true;
    try {
      await check();
    } finally {
      inFlight = false;
    }
  };
}
