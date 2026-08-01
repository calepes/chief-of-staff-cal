// tools/design-capture.ts — captura headless de un screenshot para Referencias de Diseño.
//
// Controla el navegador DIRECTO en proceso (paquete playwright), sin exponerle al LLM ninguna
// tool de navegación/ejecución de código — Jano no tiene (ni debe tener) control genérico de
// browser (ver DISALLOWED_BUILTINS en agent-options.ts). Mismo principio que boa-checkin/cine:
// el LLM llama UNA tool de alto nivel: el detalle de Playwright vive puertas adentro.

import { chromium } from "playwright";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StructuredCookie } from "./cookie-jar.js";

export interface CaptureResult {
  screenshotPath: string;
  title: string;
}

/**
 * Navega a `url` (inyectando `cookies` si vienen, para saltar el login wall de dominios
 * whitelisteados del Cookie Broker), y saca un screenshot de página completa. El archivo se
 * nombra `disref-<timestamp>.png` dentro de tmpdir() — mismo prefijo que valida
 * resolveAllowedLocalFile en telegram-files.ts para poder mandarlo por Telegram después.
 */
export async function captureDesignScreenshot(url: string, cookies: StructuredCookie[]): Promise<CaptureResult> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
    const title = await page.title();
    const screenshotPath = join(tmpdir(), `disref-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return { screenshotPath, title };
  } finally {
    await browser.close();
  }
}
