# Cine MCP — proceso persistente vía HTTP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El MCP `cine` (compra de entradas Cinemark) deja de perder el estado de una compra en curso cuando Jano/Vesta arrancan una sesión SDK nueva en cada turno — pasa de ser un subproceso `stdio` efímero (uno por turno) a un servicio HTTP persistente (uno por bot, arrancado una sola vez vía launchd).

**Architecture:** El código de tools de `cine` (cartelera + flujo de compra) se extrae a un factory `createCineServer()` reutilizable por dos entry points: el `index.ts` stdio existente (sin cambios de comportamiento) y un nuevo `http.ts` que expone el mismo servidor MCP vía `StreamableHTTPServerTransport` en modo *stateless* sobre un puerto local fijo. El estado de la compra (`compra-store.ts`, ya un `Map` a nivel de módulo) no cambia — lo único que cambia es que el proceso que lo contiene ahora vive indefinidamente (launchd `KeepAlive`) en vez de reiniciarse en cada mensaje de Telegram. Jano y Vesta dejan de spawnear `cine` como hijo de cada `startup()` del SDK y en su lugar se conectan como cliente HTTP a `http://127.0.0.1:{puerto}/mcp` — un proceso por bot, para no romper el invariante actual "una compra activa por bot".

**Tech Stack:** `@modelcontextprotocol/sdk@1.26.0` (ya instalado — `StreamableHTTPServerTransport`/`StreamableHTTPClientTransport`, sin dependencias nuevas), Node `http` nativo, launchd (macOS), vitest.

---

## Contexto para quien ejecute este plan

- Repo del MCP: `/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/cine/`
- Repo Jano: `/Users/calepes/Claude Projects/Personal/Agents/Jano/`
- Repo Vesta: `/Users/calepes/Claude Projects/Personal/Agents/Vesta/`
- El bug original: cada mensaje de Telegram dispara un `startup()` nuevo del SDK (decisión deliberada, ver `Jano/CLAUDE.md` — evita un bug distinto de "warm pool"), que spawnea un proceso `stdio` nuevo para CADA MCP registrado, incluido `cine`. `cine` guarda la compra en curso (incl. el browser de Playwright) en un `Map` a nivel de módulo (`compra-store.ts`) — memoria que se pierde en cada reinicio de proceso. Resultado: elegís un asiento en un mensaje, confirmás en el siguiente, y ese siguiente mensaje habla con un proceso `cine` recién nacido que nunca supo que la compra existía (`estadoCompraCine` devuelve `{activa:false}`).
- `boa-checkin` (otro MCP con flujo multi-paso) NO sufre esto porque su diseño es distinto: abre y cierra el browser en CADA llamada, re-buscando la reserva por PNR/apellido — no depende de memoria compartida entre llamadas. `cine` sí necesita mantener la MISMA pestaña abierta durante todo el checkout (el hold de asientos de Cinemark está atado a esa sesión de browser específica, no es un código portátil como un PNR de avión).
- Puertos elegidos (verificados libres en la Mac de Cal): **8791** para la instancia de Jano, **8792** para la de Vesta. Ambas instancias son procesos separados (no comparten Map) para preservar el comportamiento actual: "una compra activa por instancia = por bot" — una compra iniciada en Vesta no debe verse desde Jano.
- `servers/cine/tsconfig.json` tiene `"include": ["src/**/*"]` — cualquier archivo `.ts` nuevo bajo `src/` se compila solo, no hace falta tocar el tsconfig.
- Los tests existentes usan `vitest` y viven junto al código (`*.test.ts`). Correr con `npm -w mcp-cine test` desde la raíz del monorepo `mcp-servers`, o `npx vitest run` parado en `servers/cine/`.

---

## Task 1: Extraer la lógica del server MCP a un factory reutilizable

**Files:**
- Create: `servers/cine/src/mcp-server.ts`
- Modify: `servers/cine/src/index.ts`
- Test: `servers/cine/src/mcp-server.test.ts`

- [ ] **Step 1: Escribir el test que falla**

`servers/cine/src/mcp-server.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { CINE_TOOL_NAMES, createCineServer } from "./mcp-server.js";

describe("mcp-server factory", () => {
  it("expone las 7 tools de cine con los nombres esperados", () => {
    expect(CINE_TOOL_NAMES).toEqual([
      "getCartelera",
      "iniciarCompraCine",
      "elegirAsientosCine",
      "confirmarCompraCine",
      "verificarPagoCine",
      "cancelarCompraCine",
      "estadoCompraCine",
    ]);
  });

  it("createCineServer() devuelve una instancia nueva cada vez (no singleton)", () => {
    const a = createCineServer();
    const b = createCineServer();
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/cine" && npx vitest run src/mcp-server.test.ts`
Expected: FAIL — `Cannot find module './mcp-server.js'`

- [ ] **Step 3: Crear `mcp-server.ts` moviendo TODO el contenido de `index.ts` excepto el transporte stdio**

`servers/cine/src/mcp-server.ts` (contenido movido tal cual desde `index.ts` líneas 1-301, solo cambia: se envuelve la construcción del `Server` + tools + handlers + reaper en una función factory, y se exportan `CINE_TOOL_NAMES` y `createCineServer`):

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { getCartelera, type CineNombre } from "./cartelera.js";
import { resolverFecha } from "./fecha.js";
import * as compra from "./compra.js";
import { loadComprador } from "./comprador.js";
import { guardarCaptura } from "./capturas.js";
import {
  createSession,
  getSession,
  getActiveSession,
  updateSession,
  endSession,
  claimCompletion,
  nuevoPurchaseId,
  reapStaleSessions,
} from "./compra-store.js";

function asText(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

function minutosRestantes(deadline: number): number {
  return Math.max(0, Math.floor((deadline - Date.now()) / 60_000));
}

/** Falla con un mensaje que el LLM pueda accionar en vez de un undefined silencioso. */
function requireSession(purchaseId: string) {
  const s = getSession(purchaseId);
  if (s) return s;
  const activa = getActiveSession();
  throw new Error(
    activa
      ? `No existe la compra ${purchaseId}, pero hay otra activa (${activa.purchaseId}). Usá estadoCompraCine.`
      : "No hay ninguna compra activa. Iniciá una con iniciarCompraCine.",
  );
}

// Título libre → slug de la URL de Cinemark (/pelicula/{slug}).
// NO se reutiliza el `norm()` de cartelera.ts: es privado y separa con espacios,
// no con guiones. Si cambia el criterio de slug, revisar ambos.
function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const TOOLS: Tool[] = [
  {
    name: "getCartelera",
    description:
      "Cartelera de cine en Santa Cruz de la Sierra, Bolivia, para CUALQUIER fecha. Cubre 3 cines: " +
      "Cinemark (Ventura Mall), Multicine (Las Brisas) y Cine Center (MegaCenter/Trompillo). " +
      "Args: { fecha? ('hoy' | 'mañana' | 'YYYY-MM-DD'; default hoy), pelicula? (nombre libre; si se " +
      "omite lista toda la cartelera), cines? (subset de ['cinemark','multicine','cinecenter']; default " +
      "los 3) }. Devuelve por cine: { cine, ubicacion, ok, fuente, peliculas: [{ titulo, funciones: " +
      "[{ hora, formato, idioma, sala?, precioBs?, asientosDisponibles? }] }] }. " +
      "IMPORTANTE: la cartelera de HOY solo muestra funciones que TODAVÍA NO EMPEZARON — de noche es " +
      "normal que aparezcan pocas o ninguna, y NO es un error: si el usuario pregunta de noche, ofrecé " +
      "la cartelera de mañana. Al filtrar por 'pelicula' usá el título lo más completo posible: el " +
      "filtro es por coincidencia parcial, así que un término corto puede traer películas de más " +
      "(ej. 'la' matchea 'LA ODISEA' y 'EVIL DEAD: EN LLAMAS'). " +
      "'fuente' indica si Cinemark vino del API ('bff') o del scraping ('scraping', modo degradado); " +
      "en modo degradado y sin filtro de película, Cinemark devuelve títulos SIN horarios — ahí pedí " +
      "una película puntual para obtenerlos. Un cine con ok:false trae 'error' y los otros igual " +
      "responden. Tarda ~6-13s. Cine Center incluye precio en Bs.",
    inputSchema: {
      type: "object",
      properties: {
        fecha: { type: "string", description: "'hoy', 'mañana' o YYYY-MM-DD" },
        pelicula: { type: "string", description: "Filtro por nombre de película" },
        cines: {
          type: "array",
          items: { type: "string", enum: ["cinemark", "multicine", "cinecenter"] },
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "iniciarCompraCine",
    description:
      "Inicia una compra de entradas en Cinemark Ventura Mall (Santa Cruz). SOLO Cinemark: Multicine y " +
      "Cine Center no permiten compra automatizada. Args: { pelicula, hora ('20:30'), cantidad (1-10), " +
      "fecha? ('hoy'|'mañana'|'YYYY-MM-DD', default hoy) }. Abre el checkout como invitado y llega a la " +
      "selección de asientos. Devuelve { purchaseId, mapaPath, minutosRestantes }. " +
      "IMPORTANTE: (1) GUARDÁ el purchaseId — todas las tools siguientes lo necesitan. (2) Mandá el " +
      "archivo de mapaPath al usuario con enviarFotoLocal y pedile qué asientos quiere (ej. 'B12 B13'). " +
      "(3) Cinemark retiene las butacas ~8 minutos: avisá el tiempo restante. Solo puede haber UNA " +
      "compra activa a la vez.",
    inputSchema: {
      type: "object",
      properties: {
        pelicula: { type: "string" },
        hora: { type: "string", description: "Formato HH:MM, ej. '20:30'" },
        cantidad: { type: "integer", minimum: 1, maximum: 10 },
        fecha: { type: "string", description: "'hoy', 'mañana' o YYYY-MM-DD" },
      },
      required: ["pelicula", "hora", "cantidad"],
      additionalProperties: false,
    },
  },
  {
    name: "elegirAsientosCine",
    description:
      "Selecciona los asientos elegidos por el usuario. Args: { purchaseId, asientos (ej. ['B12','B13']) }. " +
      "Devuelve { resumenPath, total, minutosRestantes }. Mandá resumenPath al usuario con enviarFotoLocal " +
      "y PEDÍ CONFIRMACIÓN EXPLÍCITA antes de llamar a confirmarCompraCine. Si un asiento ya está ocupado " +
      "devuelve error: avisá y volvé a mandar el mapa.",
    inputSchema: {
      type: "object",
      properties: {
        purchaseId: { type: "string" },
        asientos: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["purchaseId", "asientos"],
      additionalProperties: false,
    },
  },
  {
    name: "confirmarCompraCine",
    description:
      "Genera el QR de pago. Args: { purchaseId }. LLAMAR SOLO tras un 'sí' EXPLÍCITO del usuario al " +
      "resumen — es el punto de no retorno del flujo. Devuelve { qrPath, minutosRestantes }. Mandá qrPath " +
      "con enviarFotoLocal y un teclado inline con el botón '✅ Ya pagué'. El usuario paga con su app " +
      "bancaria: vos NUNCA pagás. Cuando toque el botón, llamá a verificarPagoCine.",
    inputSchema: {
      type: "object",
      properties: { purchaseId: { type: "string" } },
      required: ["purchaseId"],
      additionalProperties: false,
    },
  },
  {
    name: "verificarPagoCine",
    description:
      "Verifica si el pago se acreditó. Args: { purchaseId }. Se llama cuando el usuario toca '✅ Ya pagué' " +
      "o dice que pagó. Devuelve { pagado: false } si todavía no se ve (decíselo y que reintente en unos " +
      "segundos), o { pagado: true, codigoRetiro, entradasPath } si sí. Cinemark entrega un CÓDIGO DE " +
      "RETIRO, no un QR de ingreso: el QR y la factura le llegan por correo. Mandá entradasPath y el " +
      "código, y aclarale lo del correo.",
    inputSchema: {
      type: "object",
      properties: { purchaseId: { type: "string" } },
      required: ["purchaseId"],
      additionalProperties: false,
    },
  },
  {
    name: "cancelarCompraCine",
    description:
      "Cancela la compra activa: cierra el navegador y libera las butacas. Args: { purchaseId }. Usar si " +
      "el usuario se arrepiente o se venció el tiempo de reserva.",
    inputSchema: {
      type: "object",
      properties: { purchaseId: { type: "string" } },
      required: ["purchaseId"],
      additionalProperties: false,
    },
  },
  {
    name: "estadoCompraCine",
    description:
      "Devuelve la compra activa si la hay: { purchaseId, estado, funcion, minutosRestantes }, o " +
      "{ activa: false }. Usala cuando el usuario hable de una compra en curso y vos NO tengas el " +
      "purchaseId a mano (por ejemplo tras un /reset o si se compactó la conversación). No requiere args.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
];

export const CINE_TOOL_NAMES = TOOLS.map((t) => t.name);

let reaperStarted = false;

/**
 * Arranca el reaper UNA sola vez por proceso, sin importar cuántas veces se
 * llame createCineServer() (relevante en el entry point stdio, donde antes
 * era código de módulo top-level que corría una vez per se — acá se guarda
 * explícito para no duplicar el setInterval si algo llegara a instanciar el
 * server más de una vez en el mismo proceso).
 */
function ensureReaperStarted(): void {
  if (reaperStarted) return;
  reaperStarted = true;
  // Cierra el Chrome de compras abandonadas. Sin polling de pago, es la ÚNICA
  // red de seguridad: si el usuario nunca confirma, nadie más cierra el browser.
  // unref() evita que el timer mantenga vivo el proceso por sí solo (en el modo
  // HTTP persistente esto no importa para mantener el proceso vivo — launchd ya
  // lo hace — pero sí evita que un test que arme el server dependa de un timer
  // colgado para terminar).
  const reaper = setInterval(() => {
    void reapStaleSessions()
      .then((n) => {
        if (n > 0) console.error(`[cine] reaper cerró ${n} compra(s) vencida(s)`);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[cine] reaper falló: ${msg}`);
      });
  }, 2 * 60_000);
  reaper.unref();
}

export function createCineServer(): Server {
  const server = new Server({ name: "cine", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      if (name === "getCartelera") {
        const a = args as { fecha?: string; pelicula?: string; cines?: CineNombre[] };
        const fecha = resolverFecha(a.fecha);
        return asText({ fecha, cines: await getCartelera({ ...a, fecha }) });
      }

      if (name === "iniciarCompraCine") {
        const a = args as { pelicula: string; hora: string; cantidad: number; fecha?: string };
        const fecha = resolverFecha(a.fecha);
        const purchaseId = nuevoPurchaseId();
        const r = await compra.iniciar({
          slug: slugify(a.pelicula),
          hora: a.hora,
          cantidad: a.cantidad,
          fecha,
        });
        createSession({
          purchaseId,
          browser: r.browser,
          page: r.page,
          estado: "asientos",
          funcion: { pelicula: a.pelicula, hora: a.hora, formato: "" },
          cantidad: a.cantidad,
          seatDeadline: r.seatDeadline,
          createdAt: Date.now(),
        });
        return asText({
          purchaseId,
          mapaPath: guardarCaptura("mapa", purchaseId, r.mapaScreenshot),
          minutosRestantes: minutosRestantes(r.seatDeadline),
        });
      }

      if (name === "elegirAsientosCine") {
        const a = args as { purchaseId: string; asientos: string[] };
        const s = requireSession(a.purchaseId);
        const r = await compra.elegirAsientos(
          s.page,
          a.asientos.map((x) => x.toUpperCase()),
          loadComprador("cal"),
          s.seatDeadline,
        );
        updateSession(s.purchaseId, { estado: "resumen", asientos: a.asientos, total: r.total });
        return asText({
          resumenPath: guardarCaptura("resumen", s.purchaseId, r.resumenScreenshot),
          total: r.total,
          minutosRestantes: minutosRestantes(s.seatDeadline),
        });
      }

      if (name === "confirmarCompraCine") {
        const s = requireSession((args as { purchaseId: string }).purchaseId);
        const r = await compra.generarQr(s.page, loadComprador("cal"), s.seatDeadline);
        updateSession(s.purchaseId, { estado: "pago" });
        return asText({
          qrPath: guardarCaptura("qr", s.purchaseId, r.qrScreenshot),
          minutosRestantes: minutosRestantes(s.seatDeadline),
        });
      }

      if (name === "verificarPagoCine") {
        const s = requireSession((args as { purchaseId: string }).purchaseId);
        const r = await compra.verificarPago(s.page).catch(() => ({ pagado: false as const }));
        if (!r.pagado) return asText({ pagado: false });
        // Guard atómico: dos taps rápidos de "✅ Ya pagué" no deben entregar dos veces.
        if (!claimCompletion(s.purchaseId)) return asText({ pagado: true, yaEntregado: true });
        const entradasPath = r.entradasScreenshot
          ? guardarCaptura("entradas", s.purchaseId, r.entradasScreenshot)
          : undefined;
        await endSession(s.purchaseId, "completado");
        return asText({ pagado: true, codigoRetiro: r.entradas?.codigoRetiro, entradasPath });
      }

      if (name === "cancelarCompraCine") {
        await endSession((args as { purchaseId: string }).purchaseId, "cancelado");
        return asText({ cancelado: true });
      }

      if (name === "estadoCompraCine") {
        const s = getActiveSession();
        if (!s) return asText({ activa: false });
        return asText({
          activa: true,
          purchaseId: s.purchaseId,
          estado: s.estado,
          funcion: s.funcion,
          minutosRestantes: minutosRestantes(s.seatDeadline),
        });
      }

      return { isError: true, content: [{ type: "text" as const, text: `Tool desconocida: ${name}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text" as const, text: `Error en ${name}: ${msg}` }] };
    }
  });

  ensureReaperStarted();
  return server;
}
```

- [ ] **Step 4: Reescribir `index.ts` para usar el factory (entry point stdio, sin cambios de comportamiento)**

`servers/cine/src/index.ts` (reemplaza el archivo completo):

```typescript
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCineServer } from "./mcp-server.js";

const server = createCineServer();
const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 5: Compilar y correr el test**

Run:
```bash
cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/cine"
npm run build
npx vitest run src/mcp-server.test.ts
```
Expected: build sin errores, ambos tests PASS.

- [ ] **Step 6: Correr la suite completa de cine para confirmar que el refactor no rompió nada**

Run: `cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/cine" && npx vitest run`
Expected: todos los tests existentes (`fecha.test.ts`, `cinemark-bff.test.ts`, `capturas.test.ts`, `compra-store.test.ts`, `compra.test.ts`) siguen en PASS — no deberían haber cambiado, este paso es solo para confirmar que mover código no rompió imports.

- [ ] **Step 7: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers"
git add servers/cine/src/mcp-server.ts servers/cine/src/mcp-server.test.ts servers/cine/src/index.ts
git commit -m "refactor(cine): extraer server MCP a factory reutilizable (createCineServer)"
```

---

## Task 2: Entry point HTTP persistente (stateless StreamableHTTP)

**Files:**
- Create: `servers/cine/src/http.ts`
- Modify: `servers/cine/package.json`
- Test: `servers/cine/src/http.test.ts`

- [ ] **Step 1: Escribir el test que falla**

`servers/cine/src/http.test.ts` — usa el propio cliente del SDK (`Client` + `StreamableHTTPClientTransport`) para validar el wiring HTTP de punta a punta, sin tocar Playwright/Cinemark real (solo ejercita `getCartelera`... en realidad ni eso: alcanza con `listTools`, que no dispara ninguna llamada de red externa):

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startCineHttpServer } from "./http.js";
import { CINE_TOOL_NAMES } from "./mcp-server.js";

const TEST_PORT = 8793;

let stop: () => Promise<void>;

beforeAll(async () => {
  const started = await startCineHttpServer({ port: TEST_PORT, host: "127.0.0.1" });
  stop = started.stop;
});

afterAll(async () => {
  await stop();
});

describe("cine HTTP transport", () => {
  it("responde tools/list vía HTTP con las mismas 7 tools que stdio", async () => {
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${TEST_PORT}/mcp`),
    );
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(CINE_TOOL_NAMES);
    await client.close();
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/cine" && npx vitest run src/http.test.ts`
Expected: FAIL — `Cannot find module './http.js'`

- [ ] **Step 3: Crear `http.ts`**

`servers/cine/src/http.ts`:

```typescript
import { createServer as createNodeHttpServer, type Server as NodeHttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createCineServer } from "./mcp-server.js";

export interface CineHttpServerOptions {
  port: number;
  host?: string;
}

export interface CineHttpServerHandle {
  httpServer: NodeHttpServer;
  stop: () => Promise<void>;
}

/**
 * Expone el MCP de cine por HTTP en modo STATELESS (sessionIdGenerator:
 * undefined) — no hace falta sesión a nivel de protocolo MCP porque el
 * estado real de la compra ya vive en compra-store.ts como memoria de
 * módulo: mientras este proceso no se reinicie, esa memoria persiste sin
 * importar cuántas conexiones HTTP distintas hagan las llamadas.
 */
export async function startCineHttpServer(
  opts: CineHttpServerOptions,
): Promise<CineHttpServerHandle> {
  const server = createCineServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const httpServer = createNodeHttpServer((req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    void transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, opts.host ?? "127.0.0.1", resolve);
  });

  return {
    httpServer,
    async stop() {
      await transport.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// Entry point real: node dist/http.js — requiere CINE_MCP_PORT (sin default:
// mejor fallar fuerte que escuchar en un puerto adivinado y pisar otra cosa).
const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  const portEnv = process.env.CINE_MCP_PORT;
  if (!portEnv) {
    console.error("[cine-http] Falta CINE_MCP_PORT en el entorno.");
    process.exit(1);
  }
  const port = Number(portEnv);
  if (!Number.isInteger(port) || port <= 0) {
    console.error(`[cine-http] CINE_MCP_PORT inválido: "${portEnv}"`);
    process.exit(1);
  }
  await startCineHttpServer({ port, host: "127.0.0.1" });
  console.error(`[cine-http] escuchando en http://127.0.0.1:${port}/mcp`);
}
```

> Nota gotcha ya documentada en este mismo repo (`Claude Projects/CLAUDE.md` → "Scripting gotchas"): el guard `import.meta.url === file://${process.argv[1]}` falla silenciosamente si el path tiene espacios (como `Claude Projects/`). Por eso acá se usa `new URL(import.meta.url).pathname === process.argv[1]`, que decodifica el `%20` antes de comparar — no construir el string `file://` a mano.

- [ ] **Step 4: Agregar script de arranque HTTP a `package.json`**

Modify `servers/cine/package.json` — agregar `"start:http"` dentro de `"scripts"`:

```json
{
  "name": "mcp-cine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "mcp-cine": "dist/index.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "start:http": "node dist/http.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.26.0",
    "playwright": "1.61.1"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 5: Compilar y correr el test**

Run:
```bash
cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/cine"
npm run build
npx vitest run src/http.test.ts
```
Expected: PASS.

- [ ] **Step 6: Verificación manual — levantar el proceso real y confirmar que responde**

Run:
```bash
cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/cine"
CINE_MCP_PORT=8791 node dist/http.js &
sleep 1
curl -s -X POST http://127.0.0.1:8791/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl-check","version":"0"}}}'
kill %1
```
Expected: respuesta JSON-RPC con `"result"` conteniendo `serverInfo.name: "cine"` (o, si el servidor responde como SSE, un stream con un evento `data:` que contiene ese mismo JSON — cualquiera de las dos formas confirma que el server real levantó y responde). Si `curl` devuelve error de conexión, el proceso no levantó — revisar el log del `node dist/http.js` antes de seguir.

- [ ] **Step 7: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers"
git add servers/cine/src/http.ts servers/cine/src/http.test.ts servers/cine/package.json
git commit -m "feat(cine): entry point HTTP stateless para correr como proceso persistente"
```

---

## Task 3: launchd — procesos persistentes para Jano y Vesta

**Files:**
- Create: `~/Library/LaunchAgents/com.cal.cine-mcp-jano.plist`
- Create: `~/Library/LaunchAgents/com.cal.cine-mcp-vesta.plist`

No hay tests automatizados para plists — la verificación es manual (Step 3 abajo).

- [ ] **Step 1: Crear el plist de Jano**

`~/Library/LaunchAgents/com.cal.cine-mcp-jano.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cal.cine-mcp-jano</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/cine/dist/http.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/calepes</string>
    <key>CINE_MCP_PORT</key>
    <string>8791</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/cine</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/Users/calepes/Library/Logs/cine-mcp-jano.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/calepes/Library/Logs/cine-mcp-jano.err.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Crear el plist de Vesta (mismo patrón, puerto 8792)**

`~/Library/LaunchAgents/com.cal.cine-mcp-vesta.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cal.cine-mcp-vesta</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/cine/dist/http.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/calepes</string>
    <key>CINE_MCP_PORT</key>
    <string>8792</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/cine</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/Users/calepes/Library/Logs/cine-mcp-vesta.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/calepes/Library/Logs/cine-mcp-vesta.err.log</string>
</dict>
</plist>
```

- [ ] **Step 3: Cargar ambos y verificar que están corriendo**

> ⚠️ Este paso ejecuta `launchctl bootstrap` (efecto persistente en el sistema — deja procesos corriendo indefinidamente). Confirmar con Cal antes de ejecutar si se está corriendo este plan de forma autónoma.

Run:
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cine-mcp-jano.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cine-mcp-vesta.plist
sleep 2
launchctl print gui/$(id -u)/com.cal.cine-mcp-jano | grep -E "state|pid"
launchctl print gui/$(id -u)/com.cal.cine-mcp-vesta | grep -E "state|pid"
curl -s -o /dev/null -w "jano:%{http_code}\n" -X POST http://127.0.0.1:8791/mcp -H "Content-Type: application/json" -d '{}'
curl -s -o /dev/null -w "vesta:%{http_code}\n" -X POST http://127.0.0.1:8792/mcp -H "Content-Type: application/json" -d '{}'
```
Expected: ambos `state = running` con `pid` numérico; los `curl` devuelven algún código HTTP (400 por body inválido está bien — confirma que el server responde, no que el JSON-RPC sea válido).

- [ ] **Step 4: No hay commit de código en este task** (los plists viven fuera de git, en `~/Library/LaunchAgents/`). Documentar en el CLAUDE.md correspondiente (Task 6).

---

## Task 4: Wirear Jano al endpoint HTTP persistente

**Files:**
- Modify: `Jano/daemon-v2/src/index.ts`

- [ ] **Step 1: Ubicar el bloque actual**

Leer `/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2/src/index.ts` — buscar la constante `CINE_DIST` (línea ~225-226) y el bloque `mcpServers.cine` (línea ~328-333, justo después de `worldcup`):

```typescript
const CINE_DIST =
  "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers/servers/cine/dist/index.js";
```

```typescript
    // Cartelera (BFF Cinemark + scraping Multicine/Cine Center) y compra de entradas.
    // Corre en su propio proceso: Playwright no bloquea el loop serial del daemon.
    "cine": {
      type: "stdio",
      command: NODE_BIN,
      args: [CINE_DIST],
    },
```

- [ ] **Step 2: Eliminar `CINE_DIST` y reemplazar el bloque `mcpServers.cine`**

Borrar la declaración de `CINE_DIST` (ya no se spawnea localmente). Reemplazar el bloque `"cine": {...}` por:

```typescript
    // Cartelera (BFF Cinemark + scraping Multicine/Cine Center) y compra de entradas.
    // Proceso HTTP persistente (launchd com.cal.cine-mcp-jano, puerto 8791) — NO se
    // spawnea por sesión: el flujo de compra necesita mantener el mismo browser vivo
    // entre iniciarCompraCine/elegirAsientosCine/confirmarCompraCine, y esos pasos caen
    // en turnos de Telegram distintos. Si se spawneara fresco por startup() (como el
    // resto de los MCP stdio), el estado de la compra se perdería entre un mensaje y el
    // siguiente (bug real encontrado 2026-07-25, ver docs/superpowers/plans/2026-07-25-*).
    "cine": {
      type: "http",
      url: "http://127.0.0.1:8791/mcp",
    },
```

- [ ] **Step 3: Confirmar que no queden referencias sueltas a `CINE_DIST`**

Run: `grep -n "CINE_DIST" "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2/src/index.ts"`
Expected: sin resultados.

- [ ] **Step 4: Typecheck + build**

Run:
```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
npm run typecheck -w @cos/daemon
npm -w @cos/shared run build && npm -w @cos/daemon run build
```
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/index.ts
git commit -m "fix(cine): conectar al proceso HTTP persistente en vez de spawnear stdio por turno"
```

---

## Task 5: Wirear Vesta al endpoint HTTP persistente

**Files:**
- Modify: `Vesta/daemon-v2/src/index.ts`

- [ ] **Step 1: Mismo cambio que Task 4, puerto 8792**

En `/Users/calepes/Claude Projects/Personal/Agents/Vesta/daemon-v2/src/index.ts` (líneas ~164-165 la constante, ~211-217 el bloque, mismo patrón que Jano): eliminar la constante `CINE_DIST` y reemplazar el bloque `"cine": {...}` por:

```typescript
    // Cartelera (BFF Cinemark + scraping Multicine/Cine Center) y compra de entradas.
    // Proceso HTTP persistente (launchd com.cal.cine-mcp-vesta, puerto 8792) — ver
    // Jano/docs/superpowers/plans/2026-07-25-cine-mcp-persistent-process.md para el porqué.
    "cine": {
      type: "http",
      url: "http://127.0.0.1:8792/mcp",
    },
```

- [ ] **Step 2: Confirmar que no queden referencias sueltas**

Run: `grep -n "CINE_DIST" "/Users/calepes/Claude Projects/Personal/Agents/Vesta/daemon-v2/src/index.ts"`
Expected: sin resultados.

- [ ] **Step 3: Typecheck + build**

Run (ajustar nombres de workspace si difieren de Jano — verificar `package.json` de Vesta antes de correr):
```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Vesta"
cat package.json | grep -A5 '"workspaces"'
```
Luego correr el typecheck/build equivalente al de Jano con los nombres de workspace reales de Vesta (mismo patrón `@family/shared` / `@family/daemon` según se documenta en `Personal/Agents/Jano/CLAUDE.md` → sección "Migrar Family/Vesta").

- [ ] **Step 4: Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Vesta"
git add daemon-v2/src/index.ts
git commit -m "fix(cine): conectar al proceso HTTP persistente en vez de spawnear stdio por turno"
```

---

## Task 6: Restart de ambos daemons + verificación end-to-end contra el bug real + docs

**Files:**
- Modify: `Jano/CLAUDE.md` (sección de gotchas, siguiendo el patrón ya usado para otros bugs de MCP)
- Modify: `Personal/MCP Servers/mcp-servers/CLAUDE.md` (entrada de la tabla del server `cine`)

> ⚠️ Este task reinicia daemons de producción (`launchctl bootout`/`bootstrap`) — confirmar con Cal antes de ejecutar, no asumir autorización implícita por haber aprobado el plan general (regla de "Agentes lanzados" en `~/.claude/CLAUDE.md`: cada acción con efecto persistente en producción se confirma antes de ejecutar).

- [ ] **Step 1: Restart de Jano**

Run:
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
sleep 3
launchctl print gui/$(id -u)/com.cal.cos-agent-v2 | grep -E "state|pid"
```
Expected: `state = running`.

- [ ] **Step 2: Restart de Vesta** (mismo patrón con el plist de Vesta — confirmar nombre exacto del label antes de correr, ver `Personal/Agents/CLAUDE.md` → "Vesta plist: `com.cal.family-agent-v2.plist`")

Run:
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.family-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.family-agent-v2.plist
sleep 3
launchctl print gui/$(id -u)/com.cal.family-agent-v2 | grep -E "state|pid"
```
Expected: `state = running`.

- [ ] **Step 3: Reproducir el escenario real que falló, contra Jano**

Desde Telegram (Cal, manual — no automatizable desde esta sesión):
1. Pedirle a Jano la cartelera de Cinemark y elegir una función.
2. Iniciar la compra, esperar **al menos 90 segundos** antes de responder con el asiento (el bug original se manifestó en ~76s).
3. Confirmar que el paso de elegir asiento SÍ encuentra la compra activa (no debería aparecer el mensaje "no hay ninguna compra activa").
4. Repetir la espera de >90s antes de confirmar la compra — mismo chequeo en el paso de `confirmarCompraCine`.
5. Cancelar la compra de prueba con `cancelarCompraCine` (pedirle a Jano "cancelá la compra") para no dejarla colgada innecesariamente, salvo que Cal quiera completarla de verdad.

Expected: la compra sobrevive los tres pasos sin perder el `purchaseId`, a diferencia de la sesión real documentada en `~/Library/Logs/cos-agent-v2.out.log` (timestamps `1785012780166`–`1785012906542`, 2026-07-25).

- [ ] **Step 4: Actualizar `Jano/CLAUDE.md`**

Agregar como nueva entrada en la sección de gotchas de Jano (después de la última entrada existente sobre BoA, antes de la sección "## Notion"), siguiendo el mismo formato de las entradas previas (bold + fecha + resumen + causa raíz + fix):

```markdown
- **MCP `cine` perdía el estado de la compra entre turnos — resuelto (2026-07-25):** el flujo de compra (`iniciarCompraCine` → `elegirAsientosCine` → `confirmarCompraCine`) guarda el browser de Playwright y el `Map` de sesiones en memoria del proceso del MCP (`compra-store.ts`) — necesario porque el hold de asientos de Cinemark está atado a esa pestaña específica, no es un código portátil como un PNR de avión. Pero Jano no usa warm pool (fresh `startup()` por mensaje, ver arriba) y `cine` estaba registrado `type: "stdio"` → cada mensaje de Telegram spawneaba un proceso `cine` NUEVO, con memoria vacía. Resultado: Cal elegía asiento en un mensaje, confirmaba en el siguiente, y ese siguiente mensaje hablaba con un `cine` recién nacido que nunca supo que la compra existía (`estadoCompraCine` devolvía `{activa:false}` a los ~76-90s, mucho antes de los "7 minutos restantes" que mostraba — el problema no era el timeout de Cinemark, era el reinicio de proceso). `boa-checkin` no sufre esto: abre y cierra el browser en CADA llamada, re-buscando la reserva por PNR/apellido (dato portátil), sin depender de memoria compartida entre llamadas. **Fix:** `cine` pasó de subproceso `stdio` efímero a proceso HTTP persistente (`servers/cine/src/http.ts`, `StreamableHTTPServerTransport` en modo stateless — el estado real sigue viviendo en `compra-store.ts`, lo que cambió es que el proceso que lo contiene ya no se reinicia por turno). Corre vía launchd (`com.cal.cine-mcp-jano.plist`, puerto 8791, `KeepAlive`), un proceso separado por bot (Vesta usa `com.cal.cine-mcp-vesta.plist`, puerto 8792) para preservar el invariante "una compra activa por instancia = por bot". `daemon-v2/src/index.ts` registra `cine` como `type: "http"` apuntando a `http://127.0.0.1:8791/mcp` en vez de spawnear el binario. Detalle completo: `docs/superpowers/plans/2026-07-25-cine-mcp-persistent-process.md`.
```

- [ ] **Step 5: Actualizar la tabla del server `cine` en `Personal/MCP Servers/mcp-servers/CLAUDE.md`**

Buscar la fila de la tabla que empieza con `| \`cine\` |` (línea ~35) y agregar al final del texto de la celda (antes del `|` de cierre), sin tocar el resto:

```
 **Transporte (2026-07-25):** corre como proceso HTTP persistente vía `src/http.ts` (`StreamableHTTPServerTransport` stateless, puerto por `CINE_MCP_PORT` env), no como subproceso `stdio` — necesario porque el flujo de compra necesita mantener el browser vivo ENTRE turnos de Telegram (ver gotcha en `Jano/CLAUDE.md`). `src/index.ts` (stdio) se conserva para uso interactivo/testing manual; ambos entry points comparten la lógica de tools vía el factory `createCineServer()` (`src/mcp-server.ts`). En producción corre vía launchd, un proceso por bot: `com.cal.cine-mcp-jano.plist` (8791), `com.cal.cine-mcp-vesta.plist` (8792).
```

- [ ] **Step 6: Commit de docs**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add CLAUDE.md docs/superpowers/plans/2026-07-25-cine-mcp-persistent-process.md
git commit -m "docs(cine): documentar fix de proceso HTTP persistente"

cd "/Users/calepes/Claude Projects/Personal/MCP Servers/mcp-servers"
git add CLAUDE.md
git commit -m "docs(cine): documentar transporte HTTP persistente"
```

---

## Self-Review

**1. Cobertura del problema real:** el bug (estado perdido entre turnos por reinicio de proceso `stdio`) queda resuelto por Task 1+2 (server reutilizable + transporte HTTP persistente) y Task 3+4+5 (proceso levantado una sola vez, ambos daemons apuntando a él). Task 6 valida contra el escenario EXACTO que falló (espera >90s entre pasos) y deja registro en docs. Sin gaps identificados contra lo discutido con Cal.

**2. Placeholders:** ninguno — cada step tiene código completo o comando exacto con output esperado.

**3. Consistencia de tipos/nombres:** `createCineServer()` (Task 1) se usa igual en `index.ts` (Task 1) y `http.ts` (Task 2). `CINE_TOOL_NAMES` se exporta en Task 1 y se consume en el test de Task 2. Los puertos (8791 Jano / 8792 Vesta) son consistentes entre plists (Task 3), env var `CINE_MCP_PORT` (Task 2/3) y las URLs `type:"http"` en ambos daemons (Task 4/5).

**4. Riesgos abiertos, ninguno bloqueante:**
- Si el proceso persistente de `cine` se cae y `KeepAlive` lo relanza, cualquier compra en curso en ese momento se pierde igual (mismo modo de falla que hoy, solo que mucho menos frecuente — antes pasaba en CADA mensaje, ahora solo si el proceso realmente crashea). No se agregó persistencia a disco del estado de compra — quedó fuera de alcance, discutirlo con Cal si se vuelve un problema real.
- No se agregó el server `cine` a ningún script/skill de monitoreo (`daemon-status`) — si Cal quiere verlo ahí, es un follow-up aparte, no bloquea este fix.
