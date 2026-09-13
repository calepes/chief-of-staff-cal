export interface CfKvDeps {
  accountId: string;
  namespaceId: string;
  apiToken: string;
}

const BASE = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 20_000;

export class CfKv {
  constructor(private deps: CfKvDeps) {}

  private url(key: string) {
    const { accountId, namespaceId } = this.deps;
    return `${BASE}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
  }

  private headers() {
    return { authorization: `Bearer ${this.deps.apiToken}` };
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const res = await fetch(this.url(key), { headers: this.headers(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`KV get failed: ${res.status}`);
    return (await res.json()) as T;
  }

  // Lee un value RAW (no JSON) — usado para el KV neutral "cookie-jar", donde el escritor
  // (sync-safari-cookies.mjs) guarda el header de cookies como texto plano vía `wrangler kv key put`,
  // no como JSON. get() fallaría acá porque res.json() no puede parsear "a=1; b=2" como JSON.
  async getText(key: string): Promise<string | null> {
    const res = await fetch(this.url(key), { headers: this.headers(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`KV getText failed: ${res.status}`);
    return res.text();
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const url = ttlSeconds != null && ttlSeconds > 0
      ? `${this.url(key)}?expiration_ttl=${ttlSeconds}`
      : this.url(key);
    const body = JSON.stringify(value);
    const res = await fetch(url, {
      method: "PUT",
      headers: { ...this.headers(), "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Diagnóstico (2026-07-03): "KV set failed: 400" venía sin detalle — capturamos el body
      // de error de CF (suele traer el motivo real: value/key size, TTL inválido, etc.) y el
      // tamaño+key del value que se intentó escribir, para poder diagnosticar sin adivinar.
      const errBody = await res.text().catch(() => "");
      throw new Error(`KV set failed: ${res.status} key=${key} valueBytes=${body.length} body=${errBody.slice(0, 500)}`);
    }
  }

  async delete(key: string): Promise<void> {
    const res = await fetch(this.url(key), {
      method: "DELETE",
      headers: this.headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 404) throw new Error(`KV delete failed: ${res.status}`);
  }
}

const LOCK_PREFIX = "jano:lock:";

/**
 * Lock corto anti-doble-tap por (chatId, userId): evita que dos invocaciones concurrentes
 * de `processMessage` para el MISMO callback (ej. doble tap rápido sobre una tarjeta de
 * mlog:/mskip:/msel:) editen en paralelo el mismo `message_id` reusado como placeholder.
 * No es un lock atómico (get+set, no compare-and-swap vía la REST API de CF KV) — alcanza
 * para cubrir la ventana de milisegundos de un doble-tap humano, no pensado como lock
 * distribuido de uso general. Mismo patrón que Pecunia (`ExpenseStateStore.tryAcquireLock`
 * en `pecunia-agent/daemon/src/expense-handler.ts`).
 */
export async function tryAcquireLock(kv: CfKv, chatId: number, userId: number, ttlSec: number): Promise<boolean> {
  const key = `${LOCK_PREFIX}${chatId}:${userId}`;
  const existing = await kv.get<string>(key);
  if (existing) return false;
  await kv.set(key, "1", ttlSec);
  return true;
}

export async function releaseLock(kv: CfKv, chatId: number, userId: number): Promise<void> {
  await kv.delete(`${LOCK_PREFIX}${chatId}:${userId}`);
}
