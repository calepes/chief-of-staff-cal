# Lluvia Bolivia — Alertas Proactivas + MCP On-Demand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar a Cal 3 mensajes diarios de Telegram (reporte de lluvia, confirmación del cron, alertas) para 3 ciudades vía el bot Jano, y un MCP nuevo que Jano carga on-demand con lluvia medida + pronóstico para las 11 ciudades de `lluvia-bolivia`.

**Architecture:** Un MCP nuevo (`mcp-lluvia-bolivia`, Worker CF, patrón `exchange-rate-bolivia`) envuelve la API ya existente de `lluvia-bolivia.carlos-cb4.workers.dev` + Open-Meteo Forecast API. Un cron interno nuevo en el daemon de Jano (`proactive/lluvia-check.ts`, patrón `health-sync-check.ts`) llama esa misma API de lluvia y manda los 3 mensajes. Cero cambios al Worker de `lluvia-bolivia` ni a la ingesta Python — todo lo nuevo es consumidor de la API que ya expone.

**Tech Stack:** TypeScript, Cloudflare Workers (`worker-mcp-utils`, `@modelcontextprotocol/sdk`), Node.js (`@anthropic-ai/claude-agent-sdk` daemon), `node-cron`, vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-lluvia-bolivia-alertas-mcp-design.md`

**Decisiones YAGNI tomadas al planificar (no re-litigar):**
- **Sin `MCP_AUTH_TOKEN` nuevo que generar** — se reusa el mismo wrangler secret compartido que ya usan `naabol-flights`/`feedbin` (visible como el mismo Bearer token en las entradas existentes de `~/.claude/.mcp.json`). Nunca se pega ese valor en un archivo del repo ni en un commit — el paso de `wrangler secret put` es interactivo.
- **Sin cambios a `system-prompt.ts`** — a diferencia de vuelos (que necesita un formato compartido, `VUELOS_NAABOL_INSTRUCTIONS`), acá la guía de "es pronóstico, no dato medido" vive directamente en la `description` del tool `getPronosticoLluvia`, que el modelo ya lee al decidir usarlo. Agregar cuando/si Cal ve que Jano lo presenta mal.
- **Sin test dedicado para `lluvia-check.ts`** (la orquestación con fetch+KV+Telegram) — mismo criterio que `health-sync-check.ts`, que tampoco tiene test propio en este repo. La lógica de branching real (umbral de alerta, mensajes) SÍ se extrae a una función pura testeada (`lluvia-messages.ts`).
- **Sin test para el MCP (`worker.ts`/`client.ts`)** — mismo criterio que `exchange-rate-bolivia`/`naabol-flights` (wrappers finos de fetch sin tests unitarios en este repo); se verifica con el smoke-test manual de Node que ya documenta `mcp-servers/CLAUDE.md`.

---

## Task 1: Scaffold del MCP nuevo (`mcp-lluvia-bolivia`)

**Files:**
- Create: `Personal/MCP Servers/mcp-servers/servers/lluvia-bolivia/package.json`
- Create: `Personal/MCP Servers/mcp-servers/servers/lluvia-bolivia/tsconfig.json`
- Create: `Personal/MCP Servers/mcp-servers/servers/lluvia-bolivia/wrangler.toml`

- [ ] **Step 1: Crear el directorio y `package.json`**

```json
{
  "name": "mcp-lluvia-bolivia",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "mcp-lluvia-bolivia": "dist/index.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "worker:deploy": "~/.npm-global/bin/wrangler deploy"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.26.0",
    "worker-mcp-utils": "*"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250101.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Crear `tsconfig.json`** (idéntico al de `exchange-rate-bolivia`)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "sourceMap": false,
    "types": [
      "@cloudflare/workers-types",
      "node"
    ]
  },
  "include": [
    "src/**/*"
  ]
}
```

- [ ] **Step 3: Crear `wrangler.toml`**

```toml
name = "mcp-lluvia-bolivia"
main = "src/worker.ts"
compatibility_date = "2026-04-01"
compatibility_flags = ["nodejs_compat"]
```

- [ ] **Step 4: Instalar dependencias desde la raíz del monorepo**

`servers/*` ya está en `workspaces` de la raíz (`mcp-servers/package.json`) — no hace falta tocar ese archivo.

Run: `cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers" && npm install`
Expected: instala `@modelcontextprotocol/sdk`, `worker-mcp-utils` (workspace local) y devtools para `mcp-lluvia-bolivia` sin errores.

- [ ] **Step 5: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers"
git add servers/lluvia-bolivia/package.json servers/lluvia-bolivia/tsconfig.json servers/lluvia-bolivia/wrangler.toml package-lock.json
git commit -m "scaffold: mcp-lluvia-bolivia server"
```

---

## Task 2: `client.ts` — fetch a la API de lluvia-bolivia + Open-Meteo

**Files:**
- Create: `Personal/MCP Servers/mcp-servers/servers/lluvia-bolivia/src/client.ts`

- [ ] **Step 1: Escribir `client.ts` completo**

```typescript
// client.ts — lógica de fetch compartida entre worker.ts (CF Worker) e index.ts (stdio).
// Envuelve dos fuentes: la API ya existente de lluvia-bolivia (dato MEDIDO, SYNOP/Ogimet)
// y Open-Meteo Forecast API (pronóstico de modelo, NUNCA presentado como medido).

const LLUVIA_API = "https://lluvia-bolivia.carlos-cb4.workers.dev";
const TIMEOUT_MS = 10_000;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`fetch falló: ${res.status} (${url})`);
  return (await res.json()) as T;
}

function todayLaPaz(): string {
  // Intl con timeZone da YYYY-MM-DD directo en locale en-CA — evita hacer aritmética
  // de offset a mano (ver gotcha "nunca derivar fecha con toISOString().slice()" de
  // Jano/CLAUDE.md, que aplica igual acá aunque este archivo corra también en el Worker).
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/La_Paz" }).format(new Date());
}

export interface DiaContexto {
  etiqueta: string;
  detalle: string;
  percentil: number | null;
  max_hist: number;
}

export interface DiaResponse {
  fecha: string;
  ciudad: string;
  total: number | null;
  contexto?: DiaContexto | null;
  [key: string]: unknown;
}

export async function getLluviaDia(ciudad: string, fecha?: string): Promise<DiaResponse> {
  const f = fecha ?? todayLaPaz();
  const url = `${LLUVIA_API}/api/dia?fecha=${encodeURIComponent(f)}&ciudad=${encodeURIComponent(ciudad)}`;
  return fetchJson<DiaResponse>(url);
}

export async function getLluviaSerie(ciudad: string, desde: string, hasta: string): Promise<unknown> {
  const url = `${LLUVIA_API}/api/lluvia?desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}&ciudad=${encodeURIComponent(ciudad)}`;
  return fetchJson(url);
}

export async function getLluviaResumen(desde: string, hasta: string, ciudad?: string): Promise<unknown> {
  const params = new URLSearchParams({ desde, hasta });
  if (ciudad) params.set("ciudad", ciudad);
  return fetchJson(`${LLUVIA_API}/api/resumen?${params.toString()}`);
}

export interface CiudadCoord {
  lat: number;
  lon: number;
}

// Coordenadas públicas de las 11 estaciones/aeropuertos que ya cubre lluvia-bolivia
// (verificadas contra fuentes de aviación públicas — metar-taf.com, SkyVector,
// world-airport-codes — el 2026-08-16). Nombres EXACTOS del campo `ciudad` en D1
// (ver lluvia_bolivia.py STATIONS).
export const CIUDADES: Record<string, CiudadCoord> = {
  "La Paz": { lat: -16.5103, lon: -68.1894 },
  "Santa Cruz": { lat: -17.6448, lon: -63.1354 },
  "Santa Cruz (centro)": { lat: -17.8116, lon: -63.1715 },
  "Cochabamba": { lat: -17.4211, lon: -66.1771 },
  "Oruro": { lat: -17.9626, lon: -67.0762 },
  "Tarija": { lat: -21.5557, lon: -64.7013 },
  "Trinidad": { lat: -14.8208, lon: -64.9167 },
  "Cobija": { lat: -11.0403, lon: -68.7833 },
  "Riberalta": { lat: -11.0083, lon: -66.075 },
  "Potosí": { lat: -19.5431, lon: -65.7236 },
  "Sucre": { lat: -19.0069, lon: -65.2886 },
};

export interface PronosticoDia {
  fecha: string;
  mm_estimado: number;
  probabilidad_pct: number | null;
}

export interface PronosticoResult {
  ciudad: string;
  fuente: string;
  dias: PronosticoDia[];
}

interface OpenMeteoResponse {
  daily: {
    time: string[];
    precipitation_sum: number[];
    precipitation_probability_max?: number[];
  };
}

export async function getPronosticoLluvia(ciudad: string, dias?: number): Promise<PronosticoResult> {
  const coord = CIUDADES[ciudad];
  if (!coord) {
    throw new Error(`Ciudad desconocida: "${ciudad}". Ciudades válidas: ${Object.keys(CIUDADES).join(", ")}`);
  }
  const n = Math.min(Math.max(dias ?? 7, 1), 16);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${coord.lat}&longitude=${coord.lon}` +
    `&daily=precipitation_sum,precipitation_probability_max&timezone=America%2FLa_Paz&forecast_days=${n}`;
  const data = await fetchJson<OpenMeteoResponse>(url);
  const diasResult: PronosticoDia[] = data.daily.time.map((fecha, i) => ({
    fecha,
    mm_estimado: data.daily.precipitation_sum[i],
    probabilidad_pct: data.daily.precipitation_probability_max?.[i] ?? null,
  }));
  return {
    ciudad,
    fuente: "Open-Meteo (pronóstico de modelo, NO dato medido)",
    dias: diasResult,
  };
}
```

- [ ] **Step 2: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers"
git add servers/lluvia-bolivia/src/client.ts
git commit -m "feat: mcp-lluvia-bolivia client.ts (fetch + coordenadas)"
```

---

## Task 3: `tools.ts` — schema de los 4 tools (compartido worker/stdio)

**Files:**
- Create: `Personal/MCP Servers/mcp-servers/servers/lluvia-bolivia/src/tools.ts`

- [ ] **Step 1: Escribir `tools.ts` completo**

```typescript
// tools.ts — definición de los 4 tools, compartida entre worker.ts (CF Worker) e
// index.ts (stdio). Estructuralmente compatible con McpTool de worker-mcp-utils y con
// el formato que espera @modelcontextprotocol/sdk (mismos 3 campos: name/description/inputSchema).

import { CIUDADES } from "./client.js";

export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const CIUDADES_LIST = Object.keys(CIUDADES).join(", ");
const READ_ONLY = { readOnlyHint: true };

export const TOOLS: McpToolSchema[] = [
  {
    name: "getLluviaDia",
    description:
      `Lluvia MEDIDA (SYNOP/Ogimet, no estimación) de un día en una ciudad de Bolivia, con categoría ` +
      `(Poca/Normal/Considerable/Fuerte/Excepcional) relativa al histórico de esa ciudad y su percentil. ` +
      `Ciudades: ${CIUDADES_LIST}. Sin "fecha", usa el día pluviométrico más reciente (08:00-08:00 hora Bolivia).`,
    inputSchema: {
      type: "object",
      properties: {
        ciudad: { type: "string", description: `Nombre exacto de la ciudad. Una de: ${CIUDADES_LIST}` },
        fecha: { type: "string", description: "YYYY-MM-DD, opcional" },
      },
      required: ["ciudad"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "getLluviaSerie",
    description: "Serie diaria de lluvia MEDIDA (mm) de una ciudad de Bolivia en un rango de fechas.",
    inputSchema: {
      type: "object",
      properties: {
        ciudad: { type: "string", description: `Una de: ${CIUDADES_LIST}` },
        desde: { type: "string", description: "YYYY-MM-DD" },
        hasta: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["ciudad", "desde", "hasta"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "getLluviaResumen",
    description: "Totales mensuales de lluvia MEDIDA por ciudad de Bolivia en un rango de fechas.",
    inputSchema: {
      type: "object",
      properties: {
        desde: { type: "string", description: "YYYY-MM-DD" },
        hasta: { type: "string", description: "YYYY-MM-DD" },
        ciudad: { type: "string", description: `Opcional (una de: ${CIUDADES_LIST}). Sin esto, trae todas las ciudades.` },
      },
      required: ["desde", "hasta"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "getPronosticoLluvia",
    description:
      `PRONÓSTICO de lluvia (estimación de modelo Open-Meteo, NO dato medido) para los próximos días, hasta 16. ` +
      `Ciudades: ${CIUDADES_LIST}. Presentar SIEMPRE como pronóstico/estimación, nunca como dato real — a diferencia ` +
      `de getLluviaDia/getLluviaSerie/getLluviaResumen, que sí son lo realmente llovido.`,
    inputSchema: {
      type: "object",
      properties: {
        ciudad: { type: "string", description: `Una de: ${CIUDADES_LIST}` },
        dias: { type: "number", description: "1-16, default 7" },
      },
      required: ["ciudad"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];
```

- [ ] **Step 2: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers"
git add servers/lluvia-bolivia/src/tools.ts
git commit -m "feat: mcp-lluvia-bolivia tools.ts (schema de los 4 tools)"
```

---

## Task 4: `worker.ts` — entry point del Worker CF

**Files:**
- Create: `Personal/MCP Servers/mcp-servers/servers/lluvia-bolivia/src/worker.ts`

- [ ] **Step 1: Escribir `worker.ts` completo**

```typescript
import { handleMcp, type McpEnv } from "worker-mcp-utils";
import { getLluviaDia, getLluviaResumen, getLluviaSerie, getPronosticoLluvia } from "./client.js";
import { TOOLS } from "./tools.js";

interface Env extends McpEnv {}

async function dispatchTool(name: string, args: unknown): Promise<unknown> {
  const a = (args ?? {}) as Record<string, unknown>;
  if (name === "getLluviaDia") {
    return getLluviaDia(a.ciudad as string, a.fecha as string | undefined);
  }
  if (name === "getLluviaSerie") {
    return getLluviaSerie(a.ciudad as string, a.desde as string, a.hasta as string);
  }
  if (name === "getLluviaResumen") {
    return getLluviaResumen(a.desde as string, a.hasta as string, a.ciudad as string | undefined);
  }
  if (name === "getPronosticoLluvia") {
    return getPronosticoLluvia(a.ciudad as string, a.dias as number | undefined);
  }
  throw new Error(`Unknown tool: ${name}`);
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handleMcp(req, env, TOOLS, "lluvia-bolivia", (name, args) => dispatchTool(name, args));
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 2: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers"
git add servers/lluvia-bolivia/src/worker.ts
git commit -m "feat: mcp-lluvia-bolivia worker.ts (entry CF Worker)"
```

---

## Task 5: `index.ts` — entry point stdio (el que realmente consume el daemon de Jano)

**Files:**
- Create: `Personal/MCP Servers/mcp-servers/servers/lluvia-bolivia/src/index.ts`

- [ ] **Step 1: Escribir `index.ts` completo**

```typescript
#!/usr/bin/env node
// MCP server: lluvia-bolivia
// Envuelve la API de lluvia-bolivia.carlos-cb4.workers.dev (dato MEDIDO, SYNOP/Ogimet,
// 11 ciudades) + Open-Meteo Forecast API (pronóstico, NO medido).
// Este es el entry point que consume el daemon de Jano (registrado como stdio local en
// daemon-v2/src/index.ts) — worker.ts es el entry point que usan .mcp.json/sesiones
// interactivas vía mcp-remote, mismo patrón "dos entry points" que exchange-rate-bolivia.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getLluviaDia, getLluviaResumen, getLluviaSerie, getPronosticoLluvia } from "./client.js";
import { TOOLS } from "./tools.js";

const server = new Server({ name: "lluvia-bolivia", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;
  try {
    let result: unknown;
    if (name === "getLluviaDia") {
      result = await getLluviaDia(args.ciudad as string, args.fecha as string | undefined);
    } else if (name === "getLluviaSerie") {
      result = await getLluviaSerie(args.ciudad as string, args.desde as string, args.hasta as string);
    } else if (name === "getLluviaResumen") {
      result = await getLluviaResumen(args.desde as string, args.hasta as string, args.ciudad as string | undefined);
    } else if (name === "getPronosticoLluvia") {
      result = await getPronosticoLluvia(args.ciudad as string, args.dias as number | undefined);
    } else {
      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Error en ${name}: ${(err as Error).message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers"
git add servers/lluvia-bolivia/src/index.ts
git commit -m "feat: mcp-lluvia-bolivia index.ts (entry stdio)"
```

---

## Task 6: Build + smoke-test local del MCP

**Files:** ninguno nuevo — solo compila y verifica lo escrito en Tasks 1-5.

- [ ] **Step 1: Build**

Run: `cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers" && npm -w mcp-lluvia-bolivia run build`
Expected: termina sin errores de TypeScript, genera `servers/lluvia-bolivia/dist/{index.js,worker.js,client.js,tools.js}`.

- [ ] **Step 2: Smoke-test — `tools/list`**

Run:
```bash
node -e "
const { spawn } = require('child_process');
const p = spawn('node', ['/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/lluvia-bolivia/dist/index.js']);
p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})+'\n');
p.stdout.once('data', d => { console.log(d.toString()); p.kill(); });
setTimeout(() => p.kill(), 3000);
"
```
Expected: JSON-RPC response con `result.tools` listando `getLluviaDia`, `getLluviaSerie`, `getLluviaResumen`, `getPronosticoLluvia`.

- [ ] **Step 3: Smoke-test — `tools/call getLluviaDia` (dato real, sin fecha = hoy)**

Run:
```bash
node -e "
const { spawn } = require('child_process');
const p = spawn('node', ['/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/lluvia-bolivia/dist/index.js']);
p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'getLluviaDia',arguments:{ciudad:'Cochabamba'}}})+'\n');
p.stdout.once('data', d => { console.log(d.toString()); p.kill(); });
setTimeout(() => p.kill(), 5000);
"
```
Expected: `result.content[0].text` con JSON parseable conteniendo `fecha`, `ciudad: "Cochabamba"`, `total` (número o null).

- [ ] **Step 4: Smoke-test — `tools/call getPronosticoLluvia`**

Run:
```bash
node -e "
const { spawn } = require('child_process');
const p = spawn('node', ['/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/lluvia-bolivia/dist/index.js']);
p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'getPronosticoLluvia',arguments:{ciudad:'Santa Cruz (centro)',dias:3}}})+'\n');
p.stdout.once('data', d => { console.log(d.toString()); p.kill(); });
setTimeout(() => p.kill(), 5000);
"
```
Expected: `result.content[0].text` con JSON conteniendo `fuente: "Open-Meteo (pronóstico de modelo, NO dato medido)"` y `dias` con 3 entradas `{fecha, mm_estimado, probabilidad_pct}`.

- [ ] **Step 5: Smoke-test — ciudad desconocida da error claro**

Run:
```bash
node -e "
const { spawn } = require('child_process');
const p = spawn('node', ['/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/lluvia-bolivia/dist/index.js']);
p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'getPronosticoLluvia',arguments:{ciudad:'Miami'}}})+'\n');
p.stdout.once('data', d => { console.log(d.toString()); p.kill(); });
setTimeout(() => p.kill(), 3000);
"
```
Expected: `result.isError: true`, texto conteniendo `Ciudad desconocida: "Miami"`.

No hay commit en esta tarea (no se tocan archivos).

---

## Task 7: Deploy del Worker + wire en `.mcp.json`

**Files:**
- Modify: `~/.claude/.mcp.json`

- [ ] **Step 1: Setear el secret compartido (interactivo — nunca pegar el valor en un archivo)**

Run: `cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/lluvia-bolivia" && ~/.npm-global/bin/wrangler secret put MCP_AUTH_TOKEN`
Cuando pida el valor: pegar el MISMO Bearer token que ya usan `naabol-flights`/`feedbin` (visible en las entradas existentes de `~/.claude/.mcp.json`, ya en el Keychain/gestor de Cal) — nunca escribirlo en un commit ni en este plan.
Expected: `Success! Uploaded secret MCP_AUTH_TOKEN`.

- [ ] **Step 2: Deploy**

Run: `cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers" && npm -w mcp-lluvia-bolivia run worker:deploy`
Expected: termina con la URL `https://mcp-lluvia-bolivia.carlos-cb4.workers.dev`.

- [ ] **Step 3: Verificar el deploy con curl**

Run: `curl -s https://mcp-lluvia-bolivia.carlos-cb4.workers.dev/mcp`
Expected: JSON con `result.serverInfo.name: "lluvia-bolivia"` (petición GET, sin auth — `handleMcp` solo exige el token si el cliente manda header `Authorization`).

- [ ] **Step 4: Agregar la entrada a `~/.claude/.mcp.json`** (para sesiones interactivas de Claude Code)

Abrir `~/.claude/.mcp.json`, dentro de `"mcpServers"` agregar (usando el MISMO Bearer token del Step 1, tomado de una entrada ya existente en este mismo archivo — copiar-pegar dentro del archivo, no re-escribirlo a mano):

```json
"lluvia-bolivia": {
  "type": "stdio",
  "command": "/Users/calepes/.npm-global/bin/mcp-remote",
  "args": [
    "https://mcp-lluvia-bolivia.carlos-cb4.workers.dev/mcp",
    "--header",
    "Authorization: Bearer <el mismo token que ya usan naabol-flights/feedbin en este archivo>"
  ]
}
```

- [ ] **Step 5: Commit del repo de MCP servers**

```bash
cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers"
git status
```
(Solo confirma que no quedó nada pendiente de commitear de las Tasks 1-5 — `.mcp.json` vive fuera de este repo, en `~/.claude/`, y no se versiona acá.)

---

## Task 8: Registrar el MCP en el daemon de Jano

**Files:**
- Modify: `Jano/daemon-v2/src/index.ts:271` (constante de dist path, junto a `EXCHANGE_RATE_DIST`)
- Modify: `Jano/daemon-v2/src/index.ts:317-321` (entrada en `BASE_OPTIONS.mcpServers`, junto a `"exchange-rate-bolivia"`)
- Modify: `Jano/daemon-v2/src/agent-options.ts:117` (allowlist, junto a `mcp__exchange-rate-bolivia__*`)

- [ ] **Step 1: Agregar la constante del dist path**

En `daemon-v2/src/index.ts`, agregar esta línea inmediatamente después de la definición de `EXCHANGE_RATE_DIST` (línea 271):

```typescript
const LLUVIA_BOLIVIA_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/lluvia-bolivia/dist/index.js";
```

- [ ] **Step 2: Registrar el server en `BASE_OPTIONS.mcpServers`**

Inmediatamente después del bloque `"exchange-rate-bolivia": { ... },` (líneas 317-321), agregar:

```typescript
    "lluvia-bolivia": {
      type: "stdio",
      command: NODE_BIN,
      args: [LLUVIA_BOLIVIA_DIST],
    },
```

- [ ] **Step 3: Agregar los 4 tools al allowlist**

En `daemon-v2/src/agent-options.ts`, inmediatamente después del bloque de `mcp__naabol-flights__*` (líneas 118-120), agregar:

```typescript
  // Lluvia Bolivia — dato medido (SYNOP) + pronóstico (Open-Meteo) por ciudad
  "mcp__lluvia-bolivia__getLluviaDia",
  "mcp__lluvia-bolivia__getLluviaSerie",
  "mcp__lluvia-bolivia__getLluviaResumen",
  "mcp__lluvia-bolivia__getPronosticoLluvia",
```

- [ ] **Step 4: Typecheck (sin build completo todavía — Task 11 hace el build final)**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano" && npm run typecheck -w daemon-v2`
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/index.ts daemon-v2/src/agent-options.ts
git commit -m "feat: registra MCP lluvia-bolivia en Jano (4 tools on-demand)"
```

---

## Task 9: `lluvia-messages.ts` — construcción pura de los 3 mensajes

**Files:**
- Create: `Jano/daemon-v2/src/proactive/lluvia-messages.ts`

- [ ] **Step 1: Escribir `lluvia-messages.ts` completo**

```typescript
// lluvia-messages.ts — construcción PURA de los 3 mensajes diarios de lluvia (reporte,
// confirmación del cron, alerta). Separado de lluvia-check.ts (que hace el fetch real +
// KV + envío) para que esta lógica de branching sea testeable sin mockear fetch/CfKv —
// mismo motivo por el que journal-text.ts/task-dates.ts están separados de sus
// orquestadores en este repo.

export interface CiudadDiaResultado {
  ciudad: string;
  ok: boolean; // false = el fetch mismo falló (red, HTTP error)
  total: number | null; // null = sin dato para la fecha pedida (aunque el fetch haya sido ok)
  categoria?: string | null; // Poca/Normal/Considerable/Fuerte/Excepcional, de contexto.etiqueta
  percentil?: number | null;
  maxHist?: number | null;
  error?: string;
}

export interface LluviaMessages {
  reporte: string;
  confirmacion: string;
  alerta: string | null;
}

// Umbral acordado con Cal: desde "Considerable" en adelante (p75+), no solo Fuerte/Excepcional.
const UMBRAL_ALERTA = new Set(["Considerable", "Fuerte", "Excepcional"]);

export function buildLluviaMessages(fecha: string, resultados: CiudadDiaResultado[]): LluviaMessages {
  return {
    reporte: buildReporte(fecha, resultados),
    confirmacion: buildConfirmacion(fecha, resultados),
    alerta: buildAlerta(fecha, resultados),
  };
}

function buildReporte(fecha: string, resultados: CiudadDiaResultado[]): string {
  const filas = resultados
    .map((r) => {
      const mm = r.total != null ? `${r.total} mm` : "sin dato";
      const cat = r.categoria ? ` (${r.categoria})` : "";
      return `<tr><td>${r.ciudad}</td><td>${mm}${cat}</td></tr>`;
    })
    .join("");
  return `<b>🌧️ Lluvia de hoy (${fecha})</b>\n<table><tr><th>Ciudad</th><th>Total</th></tr>${filas}</table>`;
}

function buildConfirmacion(fecha: string, resultados: CiudadDiaResultado[]): string {
  const faltantes = resultados.filter((r) => !r.ok || r.total == null);
  if (faltantes.length === 0) {
    return `✅ Cron de lluvia OK (${fecha}) — las ${resultados.length} ciudades cargaron.`;
  }
  const detalle = faltantes
    .map((r) => `${r.ciudad}${r.error ? ` (${r.error})` : " (sin dato de hoy)"}`)
    .join(", ");
  return `⚠️ Cron de lluvia con problemas (${fecha}): ${detalle}. Revisa cron.log en la Mac.`;
}

function buildAlerta(fecha: string, resultados: CiudadDiaResultado[]): string | null {
  const disparadas = resultados.filter((r) => r.categoria && UMBRAL_ALERTA.has(r.categoria));
  if (disparadas.length === 0) return null;
  const lineas = disparadas
    .map((r) => {
      const pct = r.percentil != null ? ` (percentil ${r.percentil})` : "";
      return `• <b>${r.ciudad}</b>: ${r.total} mm — ${r.categoria}${pct}`;
    })
    .join("\n");
  return `🌧️ <b>Lluvia inusual hoy (${fecha})</b>\n${lineas}`;
}
```

- [ ] **Step 2: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/proactive/lluvia-messages.ts
git commit -m "feat: lluvia-messages.ts (construcción pura de reporte/confirmación/alerta)"
```

---

## Task 10: Test de `lluvia-messages.ts`

**Files:**
- Create: `Jano/daemon-v2/src/proactive/lluvia-messages.test.ts`

- [ ] **Step 1: Escribir el archivo de test completo**

```typescript
import { describe, it, expect } from "vitest";
import { buildLluviaMessages, type CiudadDiaResultado } from "./lluvia-messages.js";

function resultado(overrides: Partial<CiudadDiaResultado> = {}): CiudadDiaResultado {
  return {
    ciudad: "Cochabamba",
    ok: true,
    total: 0,
    categoria: null,
    percentil: null,
    maxHist: null,
    ...overrides,
  };
}

describe("buildLluviaMessages — reporte", () => {
  it("lista las 3 ciudades con mm y categoría", () => {
    const { reporte } = buildLluviaMessages("2026-08-16", [
      resultado({ ciudad: "Santa Cruz (centro)", total: 12.4, categoria: "Normal" }),
      resultado({ ciudad: "Cochabamba", total: 0 }),
      resultado({ ciudad: "La Paz", total: 3.1, categoria: "Poca" }),
    ]);
    expect(reporte).toContain("Santa Cruz (centro)");
    expect(reporte).toContain("12.4 mm");
    expect(reporte).toContain("Normal");
    expect(reporte).toContain("2026-08-16");
  });

  it("muestra 'sin dato' para una ciudad sin total", () => {
    const { reporte } = buildLluviaMessages("2026-08-16", [
      resultado({ ciudad: "Cochabamba", ok: false, total: null, error: "http 500" }),
    ]);
    expect(reporte).toContain("sin dato");
  });
});

describe("buildLluviaMessages — confirmación", () => {
  it("reporta éxito si las 3 ciudades tienen dato", () => {
    const { confirmacion } = buildLluviaMessages("2026-08-16", [
      resultado({ ciudad: "Santa Cruz (centro)" }),
      resultado({ ciudad: "Cochabamba" }),
      resultado({ ciudad: "La Paz" }),
    ]);
    expect(confirmacion).toContain("✅");
    expect(confirmacion).not.toContain("⚠️");
  });

  it("reporta falla con el detalle cuando el fetch de una ciudad dio error HTTP", () => {
    const { confirmacion } = buildLluviaMessages("2026-08-16", [
      resultado({ ciudad: "Santa Cruz (centro)" }),
      resultado({ ciudad: "Cochabamba", ok: false, total: null, error: "http 500" }),
      resultado({ ciudad: "La Paz" }),
    ]);
    expect(confirmacion).toContain("⚠️");
    expect(confirmacion).toContain("Cochabamba");
    expect(confirmacion).toContain("http 500");
  });

  it("reporta falla cuando el fetch fue ok pero no hay dato de hoy (total null)", () => {
    const { confirmacion } = buildLluviaMessages("2026-08-16", [
      resultado({ ciudad: "Santa Cruz (centro)" }),
      resultado({ ciudad: "Cochabamba", ok: true, total: null }),
      resultado({ ciudad: "La Paz" }),
    ]);
    expect(confirmacion).toContain("⚠️");
    expect(confirmacion).toContain("Cochabamba");
    expect(confirmacion).toContain("sin dato de hoy");
  });
});

describe("buildLluviaMessages — alerta", () => {
  it("no dispara si ninguna ciudad pasa Considerable", () => {
    const { alerta } = buildLluviaMessages("2026-08-16", [
      resultado({ categoria: "Normal" }),
      resultado({ categoria: "Poca" }),
      resultado({ categoria: null }),
    ]);
    expect(alerta).toBeNull();
  });

  it("dispara desde Considerable en adelante", () => {
    const { alerta } = buildLluviaMessages("2026-08-16", [
      resultado({ ciudad: "Cochabamba", total: 45, categoria: "Considerable", percentil: 82 }),
    ]);
    expect(alerta).not.toBeNull();
    expect(alerta).toContain("Cochabamba");
    expect(alerta).toContain("Considerable");
    expect(alerta).toContain("82");
  });

  it("incluye todas las ciudades que dispararon, no solo la primera", () => {
    const { alerta } = buildLluviaMessages("2026-08-16", [
      resultado({ ciudad: "Cochabamba", categoria: "Fuerte" }),
      resultado({ ciudad: "La Paz", categoria: "Excepcional" }),
      resultado({ ciudad: "Santa Cruz (centro)", categoria: "Normal" }),
    ]);
    expect(alerta).toContain("Cochabamba");
    expect(alerta).toContain("La Paz");
    expect(alerta).not.toContain("Santa Cruz (centro):");
  });
});
```

- [ ] **Step 2: Correr los tests**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano" && npm run test -w daemon-v2 -- lluvia-messages`
Expected: los 7 tests pasan (2 de reporte, 3 de confirmación, 2 de alerta — más las 3 sub-cases dentro del bloque de reporte cuentan como 2 `it`, total 7 `it` en el archivo).

- [ ] **Step 3: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/proactive/lluvia-messages.test.ts
git commit -m "test: lluvia-messages.ts (reporte, confirmación, umbral de alerta)"
```

---

## Task 11: `lluvia-check.ts` — orquestación (fetch + KV dedup + envío) + wiring del cron

**Files:**
- Create: `Jano/daemon-v2/src/proactive/lluvia-check.ts`
- Modify: `Jano/daemon-v2/src/index.ts` (import + función `scheduleLluviaCheck` + call site en `loop()`)

- [ ] **Step 1: Escribir `lluvia-check.ts` completo**

```typescript
// lluvia-check.ts — orquestación diaria: fetch a lluvia-bolivia por las 3 ciudades,
// construye los 3 mensajes (lluvia-messages.ts) y los manda por Telegram. Dedup en CF
// KV para no duplicar si el daemon reinicia el mismo día. Mismo patrón que
// health-sync-check.ts (sin test propio — la lógica de branching real ya está cubierta
// por lluvia-messages.test.ts).

import type { CfKv } from "../cf-kv.js";
import { nowInLaPaz } from "../journal-capture.js";
import { sendCronMessage } from "./rich-send.js";
import { buildLluviaMessages, type CiudadDiaResultado } from "./lluvia-messages.js";

const LLUVIA_API = "https://lluvia-bolivia.carlos-cb4.workers.dev";
const TIMEOUT_MS = 10_000;
const CIUDADES = ["Santa Cruz (centro)", "Cochabamba", "La Paz"];
const DEDUP_TTL_SEC = 24 * 60 * 60;

interface DiaApiResponse {
  total: number | null;
  contexto?: { etiqueta: string; percentil: number | null; max_hist: number } | null;
}

async function fetchCiudadDia(ciudad: string, fecha: string): Promise<CiudadDiaResultado> {
  try {
    const url = `${LLUVIA_API}/api/dia?fecha=${encodeURIComponent(fecha)}&ciudad=${encodeURIComponent(ciudad)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ciudad, ok: false, total: null, error: `http ${res.status}` };
    const data = (await res.json()) as DiaApiResponse;
    return {
      ciudad,
      ok: true,
      total: data.total,
      categoria: data.contexto?.etiqueta ?? null,
      percentil: data.contexto?.percentil ?? null,
      maxHist: data.contexto?.max_hist ?? null,
    };
  } catch (err) {
    return { ciudad, ok: false, total: null, error: String(err) };
  }
}

export interface CheckLluviaOpts {
  kv: CfKv;
  botToken: string;
  chatId: number;
}

export async function checkLluvia(opts: CheckLluviaOpts): Promise<void> {
  const { kv, botToken, chatId } = opts;
  const fecha = nowInLaPaz().slice(0, 10);
  const dedupKey = `lluvia_check:${fecha}`;

  try {
    const yaCorrio = await kv.get<boolean>(dedupKey);
    if (yaCorrio) return;
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "lluvia_check_kv_error", err: String(err) }));
  }

  const resultados = await Promise.all(CIUDADES.map((c) => fetchCiudadDia(c, fecha)));
  const { reporte, confirmacion, alerta } = buildLluviaMessages(fecha, resultados);

  const mensajes = [reporte, confirmacion, alerta].filter((t): t is string => t !== null);
  for (const text of mensajes) {
    try {
      await sendCronMessage(botToken, { chatId, text });
    } catch (err) {
      console.log(JSON.stringify({ ts: Date.now(), msg: "lluvia_check_send_failed", err: String(err) }));
    }
  }

  // Se marca SIEMPRE, no solo si los 3 envíos salieron bien: el cron corre una vez al
  // día (no cada 30 min como health-sync-check), así que no hay "próximo tick" donde
  // reintentar un envío puntual que falló — el objetivo del dedup es no duplicar los 3
  // mensajes si el daemon reinicia el mismo día, no garantizar entrega (mismo criterio
  // "sin retry, sin cola" documentado en Vesta/CLAUDE.md § Decisiones de diseño).
  try {
    await kv.set(dedupKey, true, DEDUP_TTL_SEC);
  } catch (err) {
    console.log(JSON.stringify({ ts: Date.now(), msg: "lluvia_check_kv_error", err: String(err) }));
  }
}
```

- [ ] **Step 2: Importar `checkLluvia` en `index.ts`**

En `daemon-v2/src/index.ts`, agregar esta línea inmediatamente después del import de `checkHealthSync` (línea 40):

```typescript
import { checkLluvia } from "./proactive/lluvia-check.js";
```

- [ ] **Step 3: Agregar la función `scheduleLluviaCheck`**

Inmediatamente después de la función `scheduleHealthSyncCheck` (después de la línea 1762, `}`), agregar:

```typescript
/**
 * Reporte diario de lluvia + confirmación del cron de ingesta + alertas (2026-08-16,
 * pedido de Cal). 09:50 La Paz — 20 min después del cron Python de ingesta (09:30,
 * launchd, ver ~/Claude Projects/Personal/Apps/lluvia-bolivia/). 3 mensajes separados,
 * el de confirmación sale TODOS los días (éxito o falla) — a diferencia del criterio
 * "solo reportar la excepción" de health-sync-check/kpi-ingest-check, acá Cal pidió
 * explícitamente la confirmación diaria. Detalle: docs/superpowers/specs/2026-08-16-
 * lluvia-bolivia-alertas-mcp-design.md
 */
function scheduleLluviaCheck(): void {
  cron.schedule("50 9 * * *", () => {
    void checkLluvia({
      kv,
      botToken: env.COS_TELEGRAM_BOT_TOKEN,
      chatId: ALERT_CHAT_ID,
    }).catch((err) => log({ msg: "lluvia_check_unhandled_error", err: String(err) }));
  }, { timezone: "America/La_Paz" });
  log({ msg: "lluvia_check_scheduled", interval: "daily 09:50" });
}
```

- [ ] **Step 4: Registrar el cron en `loop()`**

En `daemon-v2/src/index.ts`, dentro de `loop()`, inmediatamente después de `scheduleHealthSyncCheck();` (línea 1955), agregar:

```typescript
  scheduleLluviaCheck();
```

- [ ] **Step 5: Typecheck**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano" && npm run typecheck -w daemon-v2`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/proactive/lluvia-check.ts daemon-v2/src/index.ts
git commit -m "feat: cron diario de lluvia (reporte + confirmación + alerta), 09:50 La Paz"
```

---

## Task 12: Build final, restart de Jano (con confirmación de Cal) y verificación real

**Files:** ninguno nuevo.

- [ ] **Step 1: Build completo**

Run: `cd "/Users/calepes/Claude Projects/Personal/Agents/Jano" && npm -w @cos/shared run build && npm -w @cos/daemon run build`
Expected: sin errores.

- [ ] **Step 2: Suite completa de tests**

Run: `npm run test -w daemon-v2`
Expected: todos los tests pasan (incluidos los 7 nuevos de `lluvia-messages.test.ts`), sin nuevas fallas respecto al baseline documentado del repo.

- [ ] **Step 3: Pedir confirmación explícita a Cal antes de restart**

**No ejecutar el restart sin que Cal confirme explícitamente** — es un daemon de producción (norma ya establecida en este repo, ver `Personal/Agents/CLAUDE.md`). Mostrarle el resumen de lo agregado (MCP nuevo + cron 09:50) y esperar el OK.

- [ ] **Step 4: Restart del daemon**

Run:
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
```

- [ ] **Step 5: Verificar arranque limpio en logs**

Run: `tail -50 ~/Library/Logs/cos-agent-v2.out.log`
Expected: sin excepciones de arranque; buscar `lluvia_check_scheduled` (confirma que el cron quedó registrado) con `grep lluvia_check ~/Library/Logs/cos-agent-v2.out.log`.

- [ ] **Step 6: Verificar el tool on-demand por Telegram**

Escribirle a Jano algo como *"¿cuánto llovió hoy en Cochabamba?"* o *"¿va a llover el fin de semana en Santa Cruz?"* y confirmar con Cal que la respuesta llegó con datos reales (o pronóstico, marcado como tal).

- [ ] **Step 7: Verificar el cron proactivo (forzado, sin esperar a las 09:50 real)**

Run: `launchctl kickstart -k gui/$(id -u)/com.cal.cos-agent-v2` NO fuerza el cron interno (ese vive dentro del proceso Node, no es un plist separado) — para probarlo sin esperar al horario real, ejecutar puntualmente desde un script one-off en el scratchpad que importe `checkLluvia` desde `daemon-v2/dist/proactive/lluvia-check.js` (ya compilado) y lo invoque con `{kv, botToken, chatId}` reales, mismo patrón que ya usa este repo para iterar cards sin pasar por Telegram real (ver `Jano/CLAUDE.md` § "Iterar visualmente una card"). Confirmar con Cal que llegaron los 3 mensajes (o 2, si no hubo alerta ese día) a su Telegram.

- [ ] **Step 8: Confirmar con Cal**

Preguntarle a Cal si los mensajes se ven bien (formato, contenido, ciudades correctas) antes de dar la tarea por terminada — igual que se hizo en cada activación de Rich Messages documentada en este repo.
