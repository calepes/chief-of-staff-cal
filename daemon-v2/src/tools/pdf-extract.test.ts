import { describe, it, expect } from "vitest";
import { writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { necesitaOcr, MIN_PDF_TEXT_CHARS } from "./pdf-extract.js";
import { resolveAllowedLocalFile } from "./telegram-files.js";
import { notaOcrParcial, OCR_MAX_PAGES } from "./vision.js";

// ─────────────────────────────────────────────────────────────────────────────
// BUG REAL 2026-08-04 (Cal adjuntó un comprobante escaneado por Telegram):
// el fallback a OCR estaba detrás de un `if (!text)`, o sea SOLO se disparaba
// con texto exactamente vacío. Un PDF escaneado casi nunca devuelve 0 chars —
// pdf-parse saca un artefacto mínimo (número de página, marca del generador).
// El PDF de Cal devolvió 12 caracteres → como 12 es truthy, el OCR nunca corrió
// y esos 12 chars llegaron al modelo como si fueran el documento entero.
// ─────────────────────────────────────────────────────────────────────────────
describe("necesitaOcr", () => {
  it("pide OCR con texto vacío, nulo o solo espacios", () => {
    expect(necesitaOcr("")).toBe(true);
    expect(necesitaOcr(null)).toBe(true);
    expect(necesitaOcr(undefined)).toBe(true);
    expect(necesitaOcr("   \n\t  ")).toBe(true);
  });

  it("pide OCR con el residuo típico de un PDF escaneado (el caso real: 12 chars)", () => {
    expect(necesitaOcr("Page 1 of 3")).toBe(true); // 11
    expect(necesitaOcr("\f\f Página 1")).toBe(true);
    expect("Page 1 of 3\f".length).toBe(12); // el largo exacto que se vio en el log
    expect(necesitaOcr("Page 1 of 3\f")).toBe(true);
  });

  it("NO pide OCR con una página de texto real", () => {
    const real =
      "COMPROBANTE DE PAGO. Banco de Crédito de Bolivia. Fecha: 04/08/2026. " +
      "Monto: Bs 1.250,00. Beneficiario: Carlos Lepesqueur. Referencia: 998877. " +
      "Esta operación fue procesada correctamente y queda registrada en su estado de cuenta.";
    expect(real.length).toBeGreaterThan(MIN_PDF_TEXT_CHARS);
    expect(necesitaOcr(real)).toBe(false);
  });

  it("el umbral es el límite exacto: justo debajo pide OCR, justo encima no", () => {
    expect(necesitaOcr("x".repeat(MIN_PDF_TEXT_CHARS - 1))).toBe(true);
    expect(necesitaOcr("x".repeat(MIN_PDF_TEXT_CHARS))).toBe(false);
  });

  it("no cuenta el whitespace de relleno como contenido", () => {
    // Un PDF escaneado puede traer muchos saltos de línea y casi ninguna letra:
    // sin normalizar, el largo crudo pasaría el umbral sin texto real.
    const puroWhitespace = "\n".repeat(MIN_PDF_TEXT_CHARS * 2) + "Pág 1";
    expect(necesitaOcr(puroWhitespace)).toBe(true);
  });
});

// El OCR solo convierte las primeras OCR_MAX_PAGES páginas: si el PDF tiene más,
// lo devuelto es PARCIAL. Sin este aviso el modelo presenta esas páginas como si
// fueran el documento entero.
describe("notaOcrParcial", () => {
  it("avisa cuando el OCR llegó al tope de páginas", () => {
    expect(notaOcrParcial(OCR_MAX_PAGES)).toContain("OCR limitado");
    expect(notaOcrParcial(OCR_MAX_PAGES + 1)).toContain("OCR limitado");
  });

  it("no avisa nada cuando el documento entró completo", () => {
    expect(notaOcrParcial(1)).toBe("");
    expect(notaOcrParcial(OCR_MAX_PAGES - 1)).toBe("");
    expect(notaOcrParcial(undefined)).toBe("");
  });
});

// Guard de path de leerPdfLocal. El path lo pone el daemon (no el modelo), pero la
// tool lo revalida igual — estos tests fijan ese contrato.
describe("resolveAllowedLocalFile con el patrón de leerPdfLocal", () => {
  const PDF = /\.pdf$/i;
  const dir = join(tmpdir(), `jano-test-pdfguard-${process.pid}`);

  it("acepta un .pdf real dentro de tmpdir", async () => {
    await mkdir(dir, { recursive: true });
    const p = join(dir, "file_10.pdf");
    await writeFile(p, "%PDF-1.4");
    expect(await resolveAllowedLocalFile(p, PDF)).toBeTruthy();
    await rm(dir, { recursive: true, force: true });
  });

  it("rechaza un path fuera de tmpdir", async () => {
    expect(await resolveAllowedLocalFile(join(homedir(), ".ssh", "id_ed25519.pdf"), PDF)).toBeNull();
    expect(await resolveAllowedLocalFile("/etc/passwd.pdf", PDF)).toBeNull();
  });

  it("rechaza traversal con .. aunque arranque dentro de tmpdir", async () => {
    expect(await resolveAllowedLocalFile(join(tmpdir(), "..", "..", "etc", "x.pdf"), PDF)).toBeNull();
  });

  it("rechaza un symlink dentro de tmpdir que apunta afuera", async () => {
    await mkdir(dir, { recursive: true });
    const link = join(dir, "escape.pdf");
    await rm(link, { force: true });
    // realpath() tiene que resolver el symlink ANTES de validar; si validara solo
    // el path literal, este caso pasaría el guard y leería fuera de tmpdir.
    await symlink("/etc/hosts", link);
    expect(await resolveAllowedLocalFile(link, PDF)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it("rechaza un archivo que no es .pdf", async () => {
    await mkdir(dir, { recursive: true });
    const p = join(dir, "notas.txt");
    await writeFile(p, "hola");
    expect(await resolveAllowedLocalFile(p, PDF)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});
