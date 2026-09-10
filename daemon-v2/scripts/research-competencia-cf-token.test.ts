import { describe, it, expect, vi } from "vitest";
import { resolveD1Credentials } from "./research-competencia-cf-token.js";

describe("resolveD1Credentials", () => {
  it("devuelve token+databaseId cuando el Service Account y op read funcionan", () => {
    const result = resolveD1Credentials({
      readTokenFile: () => "sa-token-123",
      readFromOnePassword: (sa, ref) => `valor-para-${ref}-con-${sa}`,
    });
    expect(result).toEqual({
      token: "valor-para-op://Daemons/Research Competencia D1/credential-con-sa-token-123",
      databaseId: "valor-para-op://Daemons/Research Competencia D1/database_id-con-sa-token-123",
    });
  });

  it("null si el archivo del Service Account está vacío, sin llamar a op read", () => {
    const readFromOnePassword = vi.fn();
    const result = resolveD1Credentials({ readTokenFile: () => "", readFromOnePassword });
    expect(result).toBeNull();
    expect(readFromOnePassword).not.toHaveBeenCalled();
  });

  it("null si leer el archivo del Service Account tira (no existe)", () => {
    const result = resolveD1Credentials({
      readTokenFile: () => {
        throw new Error("ENOENT");
      },
      readFromOnePassword: vi.fn(),
    });
    expect(result).toBeNull();
  });

  it("null si op read tira (op no instalado, vault inaccesible)", () => {
    const result = resolveD1Credentials({
      readTokenFile: () => "sa-token-123",
      readFromOnePassword: () => {
        throw new Error("command not found: op");
      },
    });
    expect(result).toBeNull();
  });

  it("null si op read devuelve string vacío para el credential", () => {
    const result = resolveD1Credentials({
      readTokenFile: () => "sa-token-123",
      readFromOnePassword: (sa, ref) => (ref.endsWith("credential") ? "" : "db-id-real"),
    });
    expect(result).toBeNull();
  });

  it("null si op read devuelve string vacío para el database_id", () => {
    const result = resolveD1Credentials({
      readTokenFile: () => "sa-token-123",
      readFromOnePassword: (sa, ref) => (ref.endsWith("database_id") ? "" : "token-real"),
    });
    expect(result).toBeNull();
  });
});
