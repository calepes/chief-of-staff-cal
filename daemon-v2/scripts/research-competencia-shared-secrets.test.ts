import { describe, it, expect, vi } from "vitest";
import { resolveSharedSecrets } from "./research-competencia-shared-secrets.js";

describe("resolveSharedSecrets", () => {
  it("devuelve las 3 credenciales cuando el Service Account y op read funcionan", () => {
    const result = resolveSharedSecrets({
      readTokenFile: () => "sa-token-123",
      readFromOnePassword: (sa, ref) => `valor-de-${ref}`,
    });
    expect(result.get("OPENROUTER_API_KEY")).toBe("valor-de-op://Daemons/OpenRouter/credential");
    expect(result.get("ELEVENLABS_API_KEY")).toBe("valor-de-op://Daemons/ElevenLabs/credential");
    expect(result.get("NOTIF_BOT_TOKEN")).toBe("valor-de-op://Daemons/Notifications Bot Token/credential");
    expect(result.size).toBe(3);
  });

  it("Map vacío si el archivo del Service Account está vacío, sin llamar a op read", () => {
    const readFromOnePassword = vi.fn();
    const result = resolveSharedSecrets({ readTokenFile: () => "", readFromOnePassword });
    expect(result.size).toBe(0);
    expect(readFromOnePassword).not.toHaveBeenCalled();
  });

  it("Map vacío si leer el archivo del Service Account tira (no existe)", () => {
    const result = resolveSharedSecrets({
      readTokenFile: () => {
        throw new Error("ENOENT");
      },
      readFromOnePassword: vi.fn(),
    });
    expect(result.size).toBe(0);
  });

  it("una referencia que falla no bloquea a las demás — fail-soft por credencial", () => {
    const result = resolveSharedSecrets({
      readTokenFile: () => "sa-token-123",
      readFromOnePassword: (sa, ref) => {
        if (ref.includes("ElevenLabs")) throw new Error("item not found");
        return `ok-${ref}`;
      },
    });
    expect(result.has("ELEVENLABS_API_KEY")).toBe(false);
    expect(result.get("OPENROUTER_API_KEY")).toBe("ok-op://Daemons/OpenRouter/credential");
    expect(result.get("NOTIF_BOT_TOKEN")).toBe("ok-op://Daemons/Notifications Bot Token/credential");
    expect(result.size).toBe(2);
  });

  it("una referencia que devuelve string vacío queda afuera del Map", () => {
    const result = resolveSharedSecrets({
      readTokenFile: () => "sa-token-123",
      readFromOnePassword: (sa, ref) => (ref.includes("OpenRouter") ? "" : "ok"),
    });
    expect(result.has("OPENROUTER_API_KEY")).toBe(false);
    expect(result.size).toBe(2);
  });
});
