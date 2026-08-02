// tools/design-capture.ts — captura headless de una referencia de diseño para Referencias de
// Diseño.
//
// Controla el navegador DIRECTO en proceso (paquete playwright), sin exponerle al LLM ninguna
// tool de navegación/ejecución de código — Jano no tiene (ni debe tener) control genérico de
// browser (ver DISALLOWED_BUILTINS en agent-options.ts). Mismo principio que boa-checkin/cine:
// el LLM llama UNA tool de alto nivel: el detalle de Playwright vive puertas adentro.
//
// Estrategia de captura (agregado 2026-08-01, pedido de Cal tras ver que un screenshot fullPage
// de un post de X/Instagram/Threads traía toda la interfaz de la red social alrededor, no la
// imagen del diseño compartido): primero intenta encontrar la imagen más grande de la página
// (el post real, filtrando avatares/íconos por tamaño) y descargarla directo — más limpio y sin
// la recompresión de un screenshot. Si no hay ninguna candidata (páginas sin <img> grande, ej.
// un dashboard renderizado con CSS/canvas), cae a un screenshot de página completa.

import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StructuredCookie } from "./cookie-jar.js";

export interface CaptureResult {
  screenshotPath: string;
  title: string;
  mode: "image" | "fullpage";
}

/** px — filtra avatares/íconos, que en X/Instagram/Threads rondan 24-88px. Un post real siempre supera esto. */
const MIN_IMAGE_DIMENSION = 200;

interface CandidateImage {
  src: string;
  area: number;
}

// Ambiente mínimo SOLO para el body de page.evaluate() (corre en el navegador, no en Node) — a
// propósito no se agrega "DOM" al lib del tsconfig, que aplicaría a TODO el paquete y podría
// chocar con los tipos de fetch/Response/Headers de Node ya usados en el resto del daemon. Estas
// declaraciones quedan acotadas a este módulo (es un archivo con import/export, no un .d.ts
// global) y solo cubren lo que este archivo necesita.
interface BrowserImageEl {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
}
declare const document: {
  querySelectorAll(selector: "img"): ArrayLike<BrowserImageEl>;
};

/** Busca la imagen más grande (ancho×alto real) de la página, ignorando data: URIs (placeholders de lazy-load). */
async function findLargestImage(page: Page): Promise<CandidateImage | null> {
  return page.evaluate((minDim) => {
    const imgs = Array.from(document.querySelectorAll("img"));
    let best: { src: string; area: number } | null = null;
    for (const img of imgs) {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w < minDim || h < minDim) continue;
      if (!img.src || !img.src.startsWith("http")) continue;
      const area = w * h;
      if (!best || area > best.area) best = { src: img.src, area };
    }
    return best;
  }, MIN_IMAGE_DIMENSION);
}

function extFromContentType(contentType: string): string {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  return ".jpg"; // default seguro — jpeg es el formato más común en CDNs de redes sociales
}

/** Descarga `src` reusando el mismo contexto (sesión/cookies) que ya navegó la página. */
async function downloadImage(context: BrowserContext, src: string): Promise<{ buffer: Buffer; ext: string } | null> {
  try {
    const res = await context.request.get(src, { timeout: 15_000 });
    if (!res.ok()) return null;
    const buffer = await res.body();
    return { buffer, ext: extFromContentType(res.headers()["content-type"] ?? "") };
  } catch {
    return null;
  }
}

/**
 * Navega a `url` (inyectando `cookies` si vienen, para saltar el login wall de dominios
 * whitelisteados del Cookie Broker). El archivo resultante se nombra `disref-<timestamp><ext>`
 * dentro de tmpdir() — mismo prefijo que valida enviarFotoLocal en telegram-files.ts para poder
 * mandarlo por Telegram después. `ext` varía (.png/.jpg/.webp/.gif) si se descargó una imagen
 * real; siempre .png si se cayó al fallback de screenshot.
 */
export async function captureDesignScreenshot(url: string, cookies: StructuredCookie[]): Promise<CaptureResult> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Solo se admiten URLs http/https, recibido: ${url}`);
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
    const title = await page.title();

    const candidate = await findLargestImage(page);
    if (candidate) {
      const downloaded = await downloadImage(context, candidate.src);
      if (downloaded) {
        const screenshotPath = join(tmpdir(), `disref-${Date.now()}${downloaded.ext}`);
        await writeFile(screenshotPath, downloaded.buffer);
        return { screenshotPath, title, mode: "image" };
      }
    }

    const screenshotPath = join(tmpdir(), `disref-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 15_000 });
    return { screenshotPath, title, mode: "fullpage" };
  } finally {
    await browser.close();
  }
}
