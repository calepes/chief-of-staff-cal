# Tarjeta Diaria de KPIs Yape (TRX + Activos DAU) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jano genera y manda a Cal por Telegram, todos los días a las 09:30 (hora La Paz), una tarjeta PNG 1080×1080 con los 2 KPIs diarios de Yape Bolivia (Transacciones y Activos DAU, con su variación % vs. la semana anterior), leídos de la misma DB de Notion que ya consume el reloj Ulanzi.

**Architecture:** Nuevo cron interno del daemon (`node-cron`, sin agente SDK): `fetchDailyKpis()` consulta Notion directo por HTTP, `renderKpiCardImage()` dibuja la tarjeta con `@napi-rs/canvas` (sin navegador), y `enviarFotoLocal()` (ya existente, se extiende su allowlist de nombre de archivo) la manda a Cal por `sendDocument`. Cualquier falla dura dispara un mensaje de texto de error en vez de la tarjeta.

**Tech Stack:** TypeScript, Node.js, `@napi-rs/canvas`, `node-cron`, Notion API (fetch directo), Telegram Bot API, Vitest.

**Spec de referencia:** `docs/superpowers/specs/2026-07-17-kpi-card-diario-design.md`

---

## Antes de empezar

- Todo este plan vive dentro de `daemon-v2/` (workspace `@cos/daemon`). Los comandos de abajo asumen que estás parado en la raíz del repo (`/Users/calepes/Claude Projects/Personal/Agents/Jano`).
- **No reinicies el daemon de producción (`com.cal.cos-agent-v2`) como parte de este plan.** El Task 9 (prueba manual) corre el flujo con `tsx` de forma aislada, sin tocar el proceso real. El restart real del daemon es una acción con efecto en producción — solo se hace después de que Cal lo confirme explícitamente, fuera de este plan.
- Cada task termina con un commit. Sigue el orden — cada task asume que el anterior ya está commiteado.

---

### Task 1: Dependencia `@napi-rs/canvas` + asset del logo

**Files:**
- Modify: `daemon-v2/package.json`
- Modify: `package-lock.json` (raíz, generado por npm)
- Create: `daemon-v2/assets/kpi-card/yape-logo.png`

- [ ] **Step 1: Copiar el logo de Yape al repo**

```bash
mkdir -p "daemon-v2/assets/kpi-card"
cp "/Users/calepes/.claude/image-cache/09a0b223-4243-4df1-9c79-3f74e6b87752/1.png" "daemon-v2/assets/kpi-card/yape-logo.png"
```

Expected: `ls daemon-v2/assets/kpi-card/yape-logo.png` muestra el archivo (~36KB, PNG 239×240).

- [ ] **Step 2: Instalar `@napi-rs/canvas` como dependencia directa de `@cos/daemon`**

```bash
npm install @napi-rs/canvas -w @cos/daemon
```

Expected: `daemon-v2/package.json` gana una línea `"@napi-rs/canvas": "^0.1.x"` dentro de `"dependencies"`. (Ya estaba resuelto de forma transitiva en `node_modules` en varios proyectos del monorepo de Cal, así que la instalación debería ser rápida — sin descarga de binarios nuevos si el caché de npm ya lo tiene.)

- [ ] **Step 3: Commit**

```bash
git add daemon-v2/package.json package-lock.json daemon-v2/assets/kpi-card/yape-logo.png
git commit -m "feat(kpi-card): agregar @napi-rs/canvas y logo de Yape Bolivia"
```

---

### Task 2: `renderKpiCardImage()` — render de la tarjeta

**Files:**
- Create: `daemon-v2/src/proactive/kpi-card-image.ts`
- Test: `daemon-v2/src/proactive/kpi-card-image.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `daemon-v2/src/proactive/kpi-card-image.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderKpiCardImage } from "./kpi-card-image.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("renderKpiCardImage", () => {
  it("devuelve un PNG válido con ambos KPIs y sus variaciones", async () => {
    const png = await renderKpiCardImage({
      trx: 12_400_000,
      trxPctChange: 0.032,
      activosDau: 8_700_000,
      activosDauPctChange: -0.011,
      fecha: "2026-07-17",
    });

    expect(png.length).toBeGreaterThan(0);
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
  });

  it("no revienta si las variaciones % vienen null", async () => {
    const png = await renderKpiCardImage({
      trx: 12_400_000,
      trxPctChange: null,
      activosDau: 8_700_000,
      activosDauPctChange: null,
      fecha: "2026-07-17",
    });

    expect(png.length).toBeGreaterThan(0);
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

```bash
npm run test -w @cos/daemon -- src/proactive/kpi-card-image.test.ts
```

Expected: FAIL — `Cannot find module './kpi-card-image.js'` (el archivo todavía no existe).

- [ ] **Step 3: Implementar `kpi-card-image.ts`**

Crear `daemon-v2/src/proactive/kpi-card-image.ts`:

```ts
import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SIZE = 1080;
const LOGO_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "kpi-card", "yape-logo.png");
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export interface DailyKpis {
  trx: number;
  trxPctChange: number | null;
  activosDau: number;
  activosDauPctChange: number | null;
  /** ISO yyyy-mm-dd */
  fecha: string;
}

export async function renderKpiCardImage(kpis: DailyKpis): Promise<Buffer> {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.roundRect(0, 0, SIZE, SIZE, 48);
  ctx.fill();
  ctx.strokeStyle = "#E5E5E5";
  ctx.lineWidth = 2;
  ctx.stroke();

  const logo = await loadImage(LOGO_PATH);
  const logoHeight = 90;
  const logoWidth = (logo.width / logo.height) * logoHeight;
  ctx.drawImage(logo, 64, 64, logoWidth, logoHeight);

  ctx.fillStyle = "#999999";
  ctx.font = "28px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(formatFecha(kpis.fecha), SIZE - 64, 110);

  ctx.fillStyle = "#7A1FA2";
  ctx.textAlign = "left";
  ctx.font = "bold 32px sans-serif";
  ctx.fillText("Foco diario · Yape Bolivia", 64, 210);

  drawTile(ctx, 64, 280, 460, 500, "Transacciones", kpis.trx, kpis.trxPctChange);
  drawTile(ctx, 556, 280, 460, 500, "Activos DAU", kpis.activosDau, kpis.activosDauPctChange);

  return canvas.toBuffer("image/png");
}

function formatFecha(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MESES[month - 1]}`;
}

function drawTile(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  valueRaw: number,
  pctChange: number | null,
): void {
  ctx.fillStyle = "#F7F4FB";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 24);
  ctx.fill();

  ctx.fillStyle = "#777777";
  ctx.font = "22px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(label, x + 32, y + 60);

  ctx.fillStyle = "#1A1A1A";
  ctx.font = "bold 72px sans-serif";
  ctx.fillText(`${(valueRaw / 1_000_000).toFixed(1)}M`, x + 32, y + 160);

  if (pctChange !== null) {
    const isNegative = pctChange < 0;
    const chipColor = isNegative ? "#FBE4E4" : "#E4F7E9";
    const textColor = isNegative ? "#CC2222" : "#1B8A3D";
    const chipText = `${pctChange >= 0 ? "+" : ""}${(pctChange * 100).toFixed(1)}%`;

    ctx.font = "bold 26px sans-serif";
    const chipWidth = ctx.measureText(chipText).width + 40;

    ctx.fillStyle = chipColor;
    ctx.beginPath();
    ctx.roundRect(x + 32, y + 190, chipWidth, 48, 24);
    ctx.fill();

    ctx.fillStyle = textColor;
    ctx.fillText(chipText, x + 52, y + 223);
  }
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

```bash
npm run test -w @cos/daemon -- src/proactive/kpi-card-image.test.ts
```

Expected: PASS — 2 tests OK.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/proactive/kpi-card-image.ts daemon-v2/src/proactive/kpi-card-image.test.ts
git commit -m "feat(kpi-card): renderKpiCardImage con @napi-rs/canvas"
```

---

### Task 3: `fetchDailyKpis()` — lectura de Notion

**Files:**
- Create: `daemon-v2/src/proactive/kpi-card-daily.ts` (solo esta función por ahora)
- Test: `daemon-v2/src/proactive/kpi-card-daily.test.ts` (solo el bloque `fetchDailyKpis` por ahora)

- [ ] **Step 1: Escribir el test que falla**

Crear `daemon-v2/src/proactive/kpi-card-daily.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fetchDailyKpis } from "./kpi-card-daily.js";

function notionResponse(overrides: Record<string, unknown> = {}) {
  return {
    results: [
      {
        properties: {
          TRX: { number: 12_400_000 },
          "TRX vs. Sem. anterior (%)": { number: 0.032 },
          "Activos DAU": { number: 8_700_000 },
          "DAU vs. Sem. anterior (%)": { number: -0.011 },
          Fecha: { date: { start: "2026-07-17" } },
          ...overrides,
        },
      },
    ],
  };
}

describe("fetchDailyKpis", () => {
  it("parsea una respuesta válida de Notion", async () => {
    const fetchFn = (async () => new Response(JSON.stringify(notionResponse()), { status: 200 })) as unknown as typeof fetch;

    const kpis = await fetchDailyKpis("fake-token", fetchFn);

    expect(kpis).toEqual({
      trx: 12_400_000,
      trxPctChange: 0.032,
      activosDau: 8_700_000,
      activosDauPctChange: -0.011,
      fecha: "2026-07-17",
    });
  });

  it("lanza si no hay resultados", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ results: [] }), { status: 200 })) as unknown as typeof fetch;

    await expect(fetchDailyKpis("fake-token", fetchFn)).rejects.toThrow("0 resultados");
  });

  it("lanza si TRX viene null", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify(notionResponse({ TRX: { number: null } })), { status: 200 })) as unknown as typeof fetch;

    await expect(fetchDailyKpis("fake-token", fetchFn)).rejects.toThrow("TRX");
  });

  it("lanza si Activos DAU viene null", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify(notionResponse({ "Activos DAU": { number: null } })), { status: 200 })) as unknown as typeof fetch;

    await expect(fetchDailyKpis("fake-token", fetchFn)).rejects.toThrow("Activos DAU");
  });

  it("lanza si la API de Notion devuelve error HTTP", async () => {
    const fetchFn = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;

    await expect(fetchDailyKpis("fake-token", fetchFn)).rejects.toThrow("401");
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

```bash
npm run test -w @cos/daemon -- src/proactive/kpi-card-daily.test.ts
```

Expected: FAIL — `Cannot find module './kpi-card-daily.js'`.

- [ ] **Step 3: Implementar `fetchDailyKpis()`**

Crear `daemon-v2/src/proactive/kpi-card-daily.ts`:

```ts
import type { DailyKpis } from "./kpi-card-image.js";

const KPI_DB_ID = "d4996efa-4053-44cf-8149-c6aee5eba52a";

interface NotionQueryResponse {
  results: Array<{
    properties: Record<string, { number?: number | null; date?: { start: string } | null }>;
  }>;
}

export async function fetchDailyKpis(
  notionToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<DailyKpis> {
  const res = await fetchFn(`https://api.notion.com/v1/databases/${KPI_DB_ID}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ page_size: 1, sorts: [{ property: "Fecha", direction: "descending" }] }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`Notion query falló con status ${res.status}`);

  const data = (await res.json()) as NotionQueryResponse;
  const row = data.results[0];
  if (!row) throw new Error("Notion query devolvió 0 resultados en KPIs diarios");

  const props = row.properties;
  const trx = props["TRX"]?.number;
  const activosDau = props["Activos DAU"]?.number;
  const fecha = props["Fecha"]?.date?.start;

  if (trx == null) throw new Error("Propiedad TRX viene null en la fila más reciente");
  if (activosDau == null) throw new Error("Propiedad Activos DAU viene null en la fila más reciente");
  if (!fecha) throw new Error("Propiedad Fecha viene vacía en la fila más reciente");

  return {
    trx,
    trxPctChange: props["TRX vs. Sem. anterior (%)"]?.number ?? null,
    activosDau,
    activosDauPctChange: props["DAU vs. Sem. anterior (%)"]?.number ?? null,
    fecha,
  };
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

```bash
npm run test -w @cos/daemon -- src/proactive/kpi-card-daily.test.ts
```

Expected: PASS — 5 tests OK.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/proactive/kpi-card-daily.ts daemon-v2/src/proactive/kpi-card-daily.test.ts
git commit -m "feat(kpi-card): fetchDailyKpis lee KPIs diarios desde Notion"
```

---

### Task 4: `checkKpiCardDaily()` — orquestación + aviso de fallas

**Files:**
- Modify: `daemon-v2/src/proactive/kpi-card-daily.ts`
- Modify: `daemon-v2/src/proactive/kpi-card-daily.test.ts`

- [ ] **Step 1: Agregar los tests que fallan**

Agregar al final de `daemon-v2/src/proactive/kpi-card-daily.test.ts` (mantener los imports/describe de `fetchDailyKpis` arriba, agregar estos imports al tope del archivo junto a los existentes):

```ts
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi, afterEach } from "vitest";

vi.mock("./kpi-card-image.js", () => ({
  renderKpiCardImage: vi.fn(async () => Buffer.from("fake-png-bytes")),
}));
vi.mock("../tools/telegram-files.js", () => ({
  enviarFotoLocal: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@cos/shared", () => ({
  sendMessage: vi.fn(async () => ({})),
}));
```

Y este bloque después del `describe("fetchDailyKpis", ...)` existente (import `checkKpiCardDaily` junto a `fetchDailyKpis` en el import de arriba, y agregar los imports de los 3 mocks):

```ts
import { renderKpiCardImage } from "./kpi-card-image.js";
import { enviarFotoLocal } from "../tools/telegram-files.js";
import { sendMessage } from "@cos/shared";

const todayFile = () => join(tmpdir(), `kpi-card-${new Date().toISOString().slice(0, 10)}.png`);

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  try {
    await unlink(todayFile());
  } catch {
    // no existía, ok
  }
});

describe("checkKpiCardDaily", () => {
  it("manda la tarjeta cuando todo sale bien", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(notionResponse()), { status: 200 })));

    await checkKpiCardDaily({ botToken: "tok", chatId: 123, notionToken: "ntn" });

    expect(renderKpiCardImage).toHaveBeenCalledTimes(1);
    expect(enviarFotoLocal).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("avisa por texto si falla la consulta a Notion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));

    await checkKpiCardDaily({ botToken: "tok", chatId: 123, notionToken: "ntn" });

    expect(renderKpiCardImage).not.toHaveBeenCalled();
    expect(enviarFotoLocal).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("avisa por texto si falla el render de la imagen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(notionResponse()), { status: 200 })));
    vi.mocked(renderKpiCardImage).mockRejectedValueOnce(new Error("logo no encontrado"));

    await checkKpiCardDaily({ botToken: "tok", chatId: 123, notionToken: "ntn" });

    expect(enviarFotoLocal).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("avisa por texto si Telegram rechaza el envío", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(notionResponse()), { status: 200 })));
    vi.mocked(enviarFotoLocal).mockResolvedValueOnce({ ok: false, error: "chat not found" });

    await checkKpiCardDaily({ botToken: "tok", chatId: 123, notionToken: "ntn" });

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

```bash
npm run test -w @cos/daemon -- src/proactive/kpi-card-daily.test.ts
```

Expected: FAIL — `checkKpiCardDaily` no existe / no está exportada.

- [ ] **Step 3: Implementar `checkKpiCardDaily()` y `notifyFailure()`**

Agregar al final de `daemon-v2/src/proactive/kpi-card-daily.ts` (y agregar los imports que faltan al tope del archivo, junto al `import type { DailyKpis }` existente):

```ts
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendMessage } from "@cos/shared";
import { renderKpiCardImage } from "./kpi-card-image.js";
import { enviarFotoLocal } from "../tools/telegram-files.js";
```

Y agregar al final del archivo:

```ts
export interface CheckKpiCardDailyOpts {
  botToken: string;
  chatId: number;
  notionToken: string;
}

export async function checkKpiCardDaily(opts: CheckKpiCardDailyOpts): Promise<void> {
  const { botToken, chatId, notionToken } = opts;

  let kpis: DailyKpis;
  try {
    kpis = await fetchDailyKpis(notionToken);
  } catch (err) {
    await notifyFailure(botToken, chatId, "no pude leer los KPIs desde Notion", err);
    return;
  }

  let imagePath: string;
  try {
    const png = await renderKpiCardImage(kpis);
    imagePath = join(tmpdir(), `kpi-card-${todayIso()}.png`);
    await writeFile(imagePath, png);
  } catch (err) {
    await notifyFailure(botToken, chatId, "no pude generar la imagen de la tarjeta", err);
    return;
  }

  const sent = await enviarFotoLocal(botToken, chatId, imagePath, "kpi-card.png");
  if (!sent.ok) {
    await notifyFailure(botToken, chatId, "no pude mandarte la tarjeta por Telegram", sent.error);
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function notifyFailure(
  botToken: string,
  chatId: number,
  motivo: string,
  err: unknown,
): Promise<void> {
  console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_card_daily_failure", motivo, err: String(err) }));
  const text = `⚠️ No pude armar la tarjeta de KPIs de hoy (${motivo}). Revisa los logs del daemon.`;
  try {
    await sendMessage(botToken, { chatId, text });
  } catch (sendErr) {
    console.error(JSON.stringify({ ts: Date.now(), msg: "kpi_card_daily_notify_failed", err: String(sendErr) }));
  }
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

```bash
npm run test -w @cos/daemon -- src/proactive/kpi-card-daily.test.ts
```

Expected: PASS — 9 tests OK (5 de `fetchDailyKpis` + 4 de `checkKpiCardDaily`).

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/proactive/kpi-card-daily.ts daemon-v2/src/proactive/kpi-card-daily.test.ts
git commit -m "feat(kpi-card): checkKpiCardDaily orquesta fetch+render+envío con aviso de fallas"
```

---

### Task 5: Extender `enviarFotoLocal` para aceptar `kpi-card-*.png`

**Files:**
- Modify: `daemon-v2/src/tools/telegram-files.ts:144`
- Create: `daemon-v2/src/tools/telegram-files.test.ts`

- [ ] **Step 1: Escribir el test que falla**

Crear `daemon-v2/src/tools/telegram-files.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enviarFotoLocal } from "./telegram-files.js";

const testFiles: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const f of testFiles.splice(0)) {
    try {
      await unlink(f);
    } catch {
      // ya no existía
    }
  }
});

describe("enviarFotoLocal", () => {
  it("rechaza un path que no matchea ningún patrón permitido", async () => {
    const path = join(tmpdir(), "algo-random.png");
    await writeFile(path, Buffer.from("fake"));
    testFiles.push(path);

    const result = await enviarFotoLocal("tok", 123, path, "algo.png");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Path no permitido");
  });

  it("acepta un archivo kpi-card-*.png dentro de tmpdir", async () => {
    const path = join(tmpdir(), "kpi-card-2026-07-17.png");
    await writeFile(path, Buffer.from("fake-png"));
    testFiles.push(path);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const result = await enviarFotoLocal("tok", 123, path, "kpi-card.png");

    expect(result.ok).toBe(true);
  });

  it("sigue aceptando boa-wallet-*.png (no rompe el flujo de BoA existente)", async () => {
    const path = join(tmpdir(), "boa-wallet-test.png");
    await writeFile(path, Buffer.from("fake-png"));
    testFiles.push(path);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const result = await enviarFotoLocal("tok", 123, path, "boa-wallet.png");

    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

```bash
npm run test -w @cos/daemon -- src/tools/telegram-files.test.ts
```

Expected: FAIL en el segundo test (`acepta un archivo kpi-card-*.png...`) — hoy el regex solo acepta `boa-wallet-*.png`, así que devuelve `ok: false`.

- [ ] **Step 3: Ampliar el regex**

En `daemon-v2/src/tools/telegram-files.ts:144`, dentro de `enviarFotoLocal`:

```ts
  const resolved = await resolveAllowedLocalFile(filePath, /^boa-wallet-.+\.png$/);
```

Reemplazar por:

```ts
  const resolved = await resolveAllowedLocalFile(filePath, /^(boa-wallet|kpi-card)-.+\.png$/);
```

Y el mensaje de error dos líneas abajo:

```ts
      error: `Path no permitido: solo se puede enviar una tarjeta .png generada por boa-checkin en ${tmpdir()} (patrón boa-wallet-*.png).`,
```

Reemplazar por:

```ts
      error: `Path no permitido: solo se puede enviar boa-wallet-*.png o kpi-card-*.png dentro de ${tmpdir()}.`,
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

```bash
npm run test -w @cos/daemon -- src/tools/telegram-files.test.ts
```

Expected: PASS — 3 tests OK.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/tools/telegram-files.ts daemon-v2/src/tools/telegram-files.test.ts
git commit -m "feat(kpi-card): enviarFotoLocal acepta también kpi-card-*.png"
```

---

### Task 6: Registrar el cron en `index.ts`

**Files:**
- Modify: `daemon-v2/src/index.ts:24` (imports)
- Modify: `daemon-v2/src/index.ts:1023-1034` (junto a `scheduleHealthSyncCheck`)
- Modify: `daemon-v2/src/index.ts:1089` (dentro de `loop()`)

No lleva test unitario propio (es wiring de cron + env vars ya cubiertos por los tests de `checkKpiCardDaily`) — se verifica con `typecheck`/`build`.

- [ ] **Step 1: Agregar el import**

En `daemon-v2/src/index.ts:24`, justo debajo de:

```ts
import { checkHealthSync } from "./proactive/health-sync-check.js";
```

Agregar:

```ts
import { checkKpiCardDaily } from "./proactive/kpi-card-daily.js";
```

- [ ] **Step 2: Agregar la función `scheduleKpiCardDaily()`**

En `daemon-v2/src/index.ts`, justo después del cierre de `scheduleHealthSyncCheck()` (línea 1034 según el spec, antes de `scheduleFocoCheckinsLocal`):

```ts
function scheduleKpiCardDaily(): void {
  cron.schedule("30 9 * * *", () => {
    void checkKpiCardDaily({
      botToken: env.COS_TELEGRAM_BOT_TOKEN,
      chatId: ALERT_CHAT_ID,
      notionToken: env.NOTION_TOKEN,
    }).catch((err) => log({ msg: "kpi_card_daily_unhandled_error", err: String(err) }));
  }, { timezone: "America/La_Paz" });
  log({ msg: "kpi_card_daily_scheduled", interval: "daily 09:30" });
}
```

- [ ] **Step 3: Llamarla desde `loop()`**

En `daemon-v2/src/index.ts`, justo después de la línea `scheduleHealthSyncCheck();` dentro de `loop()`:

```ts
  scheduleHealthSyncCheck();
```

Agregar debajo:

```ts
  // Tarjeta diaria de KPIs Yape (TRX + Activos DAU) para reenviar por WhatsApp
  // (2026-07-17, pedido de Cal, ver docs/superpowers/specs/2026-07-17-kpi-card-diario-design.md).
  scheduleKpiCardDaily();
```

- [ ] **Step 4: Typecheck y build**

```bash
npm run typecheck -w @cos/daemon
npm run build -w @cos/shared && npm run build -w @cos/daemon
```

Expected: ambos comandos terminan sin errores.

- [ ] **Step 5: Commit**

```bash
git add daemon-v2/src/index.ts
git commit -m "feat(kpi-card): registrar cron diario 09:30 de la tarjeta de KPIs"
```

---

### Task 7: Review con `daemon-health-reviewer`

`Personal/Agents/CLAUDE.md` exige invocar este subagent automáticamente después de cualquier edit a `index.ts` (además de `agent-options.ts`/`system-prompt.ts`). Este task lo deja explícito en el plan para que no se salte.

- [ ] **Step 1: Invocar el subagent**

Lanzar el agente `daemon-health-reviewer` (Agent tool) con contexto: "Revisar los cambios de `daemon-v2/src/index.ts`, `daemon-v2/src/proactive/kpi-card-daily.ts`, `daemon-v2/src/proactive/kpi-card-image.ts` y `daemon-v2/src/tools/telegram-files.ts` de los últimos commits (`git log` reciente) — nuevo cron `scheduleKpiCardDaily()` mecánico (sin agente SDK) que lee Notion, renderiza una imagen y la manda por Telegram. Solo lectura/análisis, sin aplicar cambios."

- [ ] **Step 2: Resolver hallazgos bloqueantes**

Si el reviewer marca algo como `blocking`, corregirlo en un commit nuevo antes de seguir. Los `warning`/`info` se documentan (en este plan o en `CLAUDE.md`) y se resuelven si son rápidos, o se dejan anotados como pendiente si no.

---

### Task 8: Actualizar `CLAUDE.md`

**Files:**
- Modify: `docs/superpowers/specs/../../CLAUDE.md` → en realidad: `CLAUDE.md` (raíz del repo Jano)

- [ ] **Step 1: Documentar el nuevo cron activo**

En `CLAUDE.md`, sección `## Automatización — dos capas`, en la lista de crons internos del daemon (donde está `scheduleHealthSyncCheck()`), agregar una entrada nueva siguiendo el mismo formato:

```markdown
- `scheduleKpiCardDaily()` — **ACTIVO 2026-07-17** (pedido de Cal, ver `docs/superpowers/specs/2026-07-17-kpi-card-diario-design.md`). Cron `30 9 * * *`, mecánico (sin agente SDK) — lee TRX + Activos DAU de la DB Notion "KPIs diarios" (misma fuente que Ulanzi), renderiza una tarjeta PNG 1080×1080 con `@napi-rs/canvas` y la manda a Cal por Telegram (`enviarFotoLocal`) para que la reenvíe manualmente al grupo de WhatsApp del equipo. Si falla la consulta, el render o el envío, manda un texto de error en vez de la tarjeta.
```

Y actualizar el párrafo "Estado real" al final de esa sección para reflejar que ahora hay **2 proactivos internos activos** (health-sync-check + kpi-card-daily) en vez de 1.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: documentar cron de tarjeta diaria de KPIs en CLAUDE.md"
```

---

### Task 9: Prueba manual end-to-end (aislada, sin tocar el daemon de producción)

**Files:** ninguno (solo ejecución)

- [ ] **Step 1: Correr el flujo completo con `tsx`, fuera del daemon**

Desde `daemon-v2/`:

```bash
cd daemon-v2
NOTION_TOKEN=$(grep '^NOTION_TOKEN=' ~/.claude/secrets/apps.env | cut -d'=' -f2- | tr -d '"') \
COS_TELEGRAM_BOT_TOKEN=$(grep '^COS_TELEGRAM_BOT_TOKEN=' ~/.cos-agent/.env | cut -d'=' -f2- | tr -d '"') \
npx tsx -e '
import { checkKpiCardDaily } from "./src/proactive/kpi-card-daily.js";
await checkKpiCardDaily({
  botToken: process.env.COS_TELEGRAM_BOT_TOKEN,
  chatId: 94137698,
  notionToken: process.env.NOTION_TOKEN,
});
console.log("done");
'
```

Expected: llega la tarjeta real a Cal por Telegram (chat 94137698) con los datos de hoy, y la terminal imprime `done`.

- [ ] **Step 2: Prueba de falla forzada**

Repetir el mismo comando pero con `NOTION_TOKEN=token-invalido` — expected: llega un mensaje de texto de error a Telegram (`⚠️ No pude armar la tarjeta de KPIs de hoy...`) en vez de la imagen, y la terminal igual imprime `done` (la función no relanza la excepción).

- [ ] **Step 3: Confirmar con Cal antes de activar en producción**

Este task NO reinicia `com.cal.cos-agent-v2`. Una vez que Cal valide visualmente la tarjeta que llegó en el Step 1, pedirle confirmación explícita para:

```bash
npm run build
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cal.cos-agent-v2.plist
```

No ejecutar estos 3 comandos sin ese OK explícito.

---

## Self-review

- **Cobertura del spec:** fuente de datos (Task 3), render (Task 2), allowlist de Telegram (Task 5), orquestación + manejo de fallas con aviso de texto (Task 4, actualizado tras el pedido de Cal de avisar en vez de callar), cron 09:30 diario 7/7 (Task 6), asset del logo + dependencia (Task 1), documentación (Task 8), prueba end-to-end sin tocar producción (Task 9), review obligatorio de `daemon-health-reviewer` por tocar `index.ts` (Task 7) — todo cubierto.
- **Placeholders:** ninguno — cada step tiene código completo o comando exacto con output esperado.
- **Consistencia de tipos:** `DailyKpis` se define una sola vez (`kpi-card-image.ts`) y se importa por tipo en `kpi-card-daily.ts`, sin duplicar la forma del objeto. `CheckKpiCardDailyOpts` se usa igual en la firma (Task 4) y en el registro del cron (Task 6, mismos 3 campos: `botToken`, `chatId`, `notionToken`).
