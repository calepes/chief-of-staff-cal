import type { QueueMessage } from "@cos/shared";

export interface QueuePollerDeps {
  accountId: string;
  queueId: string;
  apiToken: string;
}

const BASE = "https://api.cloudflare.com/client/v4";

export interface PulledMessage {
  leaseId: string;
  body: QueueMessage;
}

export class QueuePoller {
  constructor(private deps: QueuePollerDeps) {}

  private headers() {
    return {
      authorization: `Bearer ${this.deps.apiToken}`,
      "content-type": "application/json",
    };
  }

  async pull(batchSize = 10): Promise<PulledMessage[]> {
    const url = `${BASE}/accounts/${this.deps.accountId}/queues/${this.deps.queueId}/messages/pull`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ batch_size: batchSize, visibility_timeout_ms: 30000 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`pull failed: ${res.status} ${errText}`);
    }
    const data = (await res.json()) as { result?: { messages?: Array<{ lease_id: string; body: unknown }> } };
    const messages = data.result?.messages ?? [];
    return messages.map((m) => ({
      leaseId: m.lease_id,
      body: typeof m.body === "string" ? (JSON.parse(m.body) as QueueMessage) : (m.body as QueueMessage),
    }));
  }

  async ack(leaseIds: string[]): Promise<void> {
    if (leaseIds.length === 0) return;
    const url = `${BASE}/accounts/${this.deps.accountId}/queues/${this.deps.queueId}/messages/ack`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ acks: leaseIds.map((id) => ({ lease_id: id })) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`ack failed: ${res.status} ${errText}`);
    }
  }
}
