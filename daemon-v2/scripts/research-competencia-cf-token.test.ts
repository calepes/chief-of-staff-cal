import { describe, it, expect, vi } from "vitest";
import { resolveD1Token } from "./research-competencia-cf-token.js";

describe("resolveD1Token", () => {
  it("devuelve el token leído de 1Password vía el Service Account", () => {
    const readTokenFile = vi.fn().mockReturnValue("sa-token-abc");
    const readFromOnePassword = vi.fn().mockReturnValue("cf-d1-token-xyz");
    const token = resolveD1Token({ readTokenFile, readFromOnePassword });
    expect(token).toBe("cf-d1-token-xyz");
    expect(readFromOnePassword).toHaveBeenCalledWith("sa-token-abc");
  });

  it("devuelve null si el archivo del Service Account está vacío, sin tirar", () => {
    const readTokenFile = vi.fn().mockReturnValue("");
    const readFromOnePassword = vi.fn();
    const token = resolveD1Token({ readTokenFile, readFromOnePassword });
    expect(token).toBeNull();
    expect(readFromOnePassword).not.toHaveBeenCalled();
  });

  it("devuelve null si op read tira (vault inaccesible, op no instalado), sin tirar", () => {
    const readTokenFile = vi.fn().mockReturnValue("sa-token-abc");
    const readFromOnePassword = vi.fn().mockImplementation(() => {
      throw new Error("op: command not found");
    });
    const token = resolveD1Token({ readTokenFile, readFromOnePassword });
    expect(token).toBeNull();
  });

  it("devuelve null si op read devuelve string vacío", () => {
    const readTokenFile = vi.fn().mockReturnValue("sa-token-abc");
    const readFromOnePassword = vi.fn().mockReturnValue("");
    const token = resolveD1Token({ readTokenFile, readFromOnePassword });
    expect(token).toBeNull();
  });
});
