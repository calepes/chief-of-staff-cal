export interface CfKvDeps {
  accountId: string;
  namespaceId: string;
  apiToken: string;
}

const BASE = "https://api.cloudflare.com/client/v4";

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
    const res = await fetch(this.url(key), { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`KV get failed: ${res.status}`);
    return (await res.json()) as T;
  }

  async set(key: string, value: unknown, ttlSeconds = 600): Promise<void> {
    const url = `${this.url(key)}?expiration_ttl=${ttlSeconds}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    if (!res.ok) throw new Error(`KV set failed: ${res.status}`);
  }

  async delete(key: string): Promise<void> {
    const res = await fetch(this.url(key), {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404) throw new Error(`KV delete failed: ${res.status}`);
  }
}
