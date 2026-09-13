const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface PersonasDeps {
  notionToken: string;
  peopleDbId: string;
}

export interface Persona {
  pageId: string;          // sin guiones (32 hex) — formato Notion canónico
  pageIdUuid: string;      // con guiones — formato API
  name: string;
  rol?: string;
}

// Mapping conocido (de ~/AI Projects/notion-reference.md). Sirve como fallback
// si la query a la DB People falla (ej. permisos). El cache de la DB lo
// sobrescribe en el siguiente fetch exitoso.
const KNOWN: Persona[] = [
  { pageId: "2f2fc7e7523043b2b65c19d38f608de7", pageIdUuid: "2f2fc7e7-5230-43b2-b65c-19d38f608de7", name: "Cal", rol: "CEO Yape Bolivia" },
  { pageId: "1a8c487609dd8031b1ded5c21624045d", pageIdUuid: "1a8c4876-09dd-8031-b1de-d5c21624045d", name: "Lorena Velasco", rol: "Comercial" },
  { pageId: "1f3c487609dd8007975cf9bf5fac6d5e", pageIdUuid: "1f3c4876-09dd-8007-975c-f9bf5fac6d5e", name: "Mauricio Rojas", rol: "Marketing / Growth" },
  { pageId: "233c487609dd808e9082c483062ceb26", pageIdUuid: "233c4876-09dd-808e-9082-c483062ceb26", name: "Matias Papini", rol: "Producto / Comercios" },
  { pageId: "2a2c487609dd80d3aafbc18a57b2f933", pageIdUuid: "2a2c4876-09dd-80d3-aafb-c18a57b2f933", name: "Ivan Contreras", rol: "Tech Lead" },
  { pageId: "209c487609dd8058ace8c1ce7f1cc8c7", pageIdUuid: "209c4876-09dd-8058-ace8-c1ce7f1cc8c7", name: "Adrian Montaño" },
  { pageId: "202c487609dd806aab73c180661ca951", pageIdUuid: "202c4876-09dd-806a-ab73-c180661ca951", name: "Yalile Uriarte", rol: "Data / Analytics" },
];

let cache: Persona[] | null = null;
let cachedAt = 0;
const TTL_MS = 60 * 60 * 1000; // 1h

export async function getPersonas(deps: PersonasDeps, force = false): Promise<Persona[]> {
  if (!force && cache && Date.now() - cachedAt < TTL_MS) return cache;
  try {
    const res = await fetch(`${NOTION_API}/databases/${deps.peopleDbId}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${deps.notionToken}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 100 }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = (await res.json()) as { results: Array<{ id: string; properties: Record<string, Record<string, unknown>> }> };
    cache = data.results.map((p) => {
      const titleArr =
        (p.properties.Nombre?.title as Array<{ plain_text: string }>) ??
        (p.properties.Name?.title as Array<{ plain_text: string }>) ??
        [];
      const id = p.id; // viene con guiones
      return {
        pageIdUuid: id,
        pageId: id.replace(/-/g, ""),
        name: titleArr.map((t) => t.plain_text).join(""),
      };
    });
    cachedAt = Date.now();
    return cache;
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "getPersonas_fallback_known", err: String(err) }));
    return KNOWN;
  }
}

export function clearPersonasCache(): void {
  cache = null;
  cachedAt = 0;
}

export function knownPersonas(): Persona[] {
  return KNOWN;
}
