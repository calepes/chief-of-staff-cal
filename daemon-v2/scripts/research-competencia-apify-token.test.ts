import { describe, it, expect, vi } from "vitest";
import { resolveApifyToken } from "./research-competencia-apify-token.js";

describe("resolveApifyToken", () => {
  it("devuelve el token cuando el Service Account y op read funcionan", () => {
    const token = resolveApifyToken({
      readTokenFile: () => "sa-token-123",
      readFromOnePassword: (sa) => `apify-token-para-${sa}`,
    });
    expect(token).toBe("apify-token-para-sa-token-123");
  });

  it("null si el archivo del Service Account está vacío, sin llamar a op read", () => {
    const readFromOnePassword = vi.fn();
    const token = resolveApifyToken({ readTokenFile: () => "", readFromOnePassword });
    expect(token).toBeNull();
    expect(readFromOnePassword).not.toHaveBeenCalled();
  });

  it("null si leer el archivo del Service Account tira (no existe)", () => {
    const token = resolveApifyToken({
      readTokenFile: () => {
        throw new Error("ENOENT");
      },
      readFromOnePassword: vi.fn(),
    });
    expect(token).toBeNull();
  });

  it("null si op read tira (op no instalado, vault inaccesible)", () => {
    const token = resolveApifyToken({
      readTokenFile: () => "sa-token-123",
      readFromOnePassword: () => {
        throw new Error("command not found: op");
      },
    });
    expect(token).toBeNull();
  });

  it("null si op read devuelve string vacío", () => {
    const token = resolveApifyToken({
      readTokenFile: () => "sa-token-123",
      readFromOnePassword: () => "",
    });
    expect(token).toBeNull();
  });
});
