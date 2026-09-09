// Cliente D1 vía REST API de Cloudflare directa — sin Worker, sin wrangler, sin binding.
// research-competencia-now.ts corre standalone en Node local, así que hace el mismo fetch que
// ya hace contra Google Ads Transparency Center / Meta Ad Library (research-competencia-ads.ts).
// Fail-soft en todo el archivo: D1 es una capa ADICIONAL sobre el research (histórico de posts,
// dedupe), nunca bloqueante — mismo criterio que Apify/Google Ads (research-competencia-apify.ts).

export interface D1QueryDeps {
  fetchFn?: typeof fetch;
  accountId?: string;
  databaseId?: string;
  token?: string;
}

interface D1ApiResponse {
  success: boolean;
  result?: Array<{ success: boolean; results: Record<string, unknown>[] }>;
  errors?: unknown[];
}

/**
 * Ejecuta una query SQL contra la D1 database de research-competencia. Devuelve las filas del
 * primer statement, o `null` ante cualquier problema (config faltante, HTTP no-ok, `success:false`,
 * red caída) — nunca tira. `params` son SOLO posicionales (`?`) — D1 no soporta params nombrados
 * (verificado contra la doc oficial, 2026-09-08).
 */
export async function queryD1(
  sql: string,
  params: unknown[] = [],
  deps: D1QueryDeps = {},
): Promise<Record<string, unknown>[] | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  const accountId = deps.accountId ?? process.env.CF_ACCOUNT_ID;
  const databaseId = deps.databaseId ?? process.env.D1_RESEARCH_COMPETENCIA_DATABASE_ID;
  const token = deps.token ?? process.env.CF_API_TOKEN_D1_RESEARCH_COMPETENCIA;
  if (!accountId || !databaseId || !token) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_d1_missing_config" }));
    return null;
  }
  try {
    const res = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sql, params }),
      },
    );
    if (!res.ok) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_d1_http_error", status: res.status }));
      return null;
    }
    const data = (await res.json()) as D1ApiResponse;
    if (!data.success || !data.result?.[0]) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_d1_query_error", errors: data.errors }));
      return null;
    }
    return data.result[0].results;
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "research_competencia_d1_fetch_error", err: String(err) }));
    return null;
  }
}
