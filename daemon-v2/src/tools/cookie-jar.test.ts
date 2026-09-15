import { afterEach, describe, it, expect } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CfKv } from "../cf-kv.js";
import { addDomainAndSync, getStructuredCookies, isDomainAllowed, matchesDomain, runCookieJarSync } from "./cookie-jar.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempConfig(domains: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "jano-cookie-jar-test-"));
  tempDirs.push(dir);
  const path = join(dir, "domains.json");
  writeFileSync(path, JSON.stringify({ ttlSeconds: 86400, domains: domains.map((domain) => ({ domain })) }));
  return path;
}

function configuredDomains(path: string): string[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { domains: Array<{ domain: string }> }).domains.map((d) => d.domain);
}

function fakeKv(header: string | null): CfKv {
  return {
    async getText(): Promise<string | null> {
      return header;
    },
  } as unknown as CfKv;
}

describe("matchesDomain", () => {
  it("matchea el mismo dominio exacto", () => {
    expect(matchesDomain("iupana.com", "iupana.com")).toBe(true);
  });

  it("matchea subdominio contra dominio configurado", () => {
    expect(matchesDomain("www.iupana.com", "iupana.com")).toBe(true);
  });

  it("matchea dominio configurado con subdominio contra hostname base", () => {
    expect(matchesDomain("iupana.com", "www.iupana.com")).toBe(true);
  });

  it("NO matchea dominios que solo comparten sufijo de texto", () => {
    expect(matchesDomain("notiupana.com", "iupana.com")).toBe(false);
  });

  it("es case-insensitive", () => {
    expect(matchesDomain("WWW.Iupana.COM", "iupana.com")).toBe(true);
  });
});

describe("isDomainAllowed — regla dura: solo medios de noticias, nunca banca/email", () => {
  it("permite medios de noticias conocidos", () => {
    for (const d of ["iupana.com", "elcomercio.pe", "eltiempo.com", "nytimes.com", "stratechery.com"]) {
      expect(isDomainAllowed(d)).toBe(true);
    }
  });

  it("bloquea proveedores de email", () => {
    for (const d of ["gmail.com", "mail.google.com", "outlook.com", "hotmail.com", "icloud.com", "yahoo.com", "correo.bo"]) {
      expect(isDomainAllowed(d)).toBe(false);
    }
  });

  it("bloquea bancos de Bolivia y Perú", () => {
    for (const d of [
      "bcp.com.pe", "interbank.pe", "bbva.pe", "scotiabank.com.pe",
      "bnb.com.bo", "bisa.com.bo", "fie.com.bo", "bancoganadero.com.bo",
      "bancofassil.com.bo", "baneco.com.bo", "bancounion.com.bo", "prodem.com.bo",
      "bmsc.com.bo", "mercantilsantacruz.com.bo", "bancosol.com.bo", "bancofortaleza.com.bo",
    ]) {
      expect(isDomainAllowed(d)).toBe(false);
    }
  });

  it("bloquea billeteras/fintech y cripto", () => {
    for (const d of ["yape.com.pe", "paypal.com", "mercadopago.com", "binance.com", "coinbase.com", "wise.com"]) {
      expect(isDomainAllowed(d)).toBe(false);
    }
  });
});

describe("getStructuredCookies", () => {
  it("devuelve whitelisted:false para un dominio fuera de la whitelist", async () => {
    const result = await getStructuredCookies("noestaenlawhitelist.com", fakeKv(null));
    expect(result).toEqual({ whitelisted: false, domain: null, cookies: [] });
  });

  it("parsea el header en cookies estructuradas cuando el dominio está whitelisteado", async () => {
    const result = await getStructuredCookies("www.iupana.com", fakeKv("a=1; b=2"));
    expect(result.whitelisted).toBe(true);
    expect(result.domain).toBe("iupana.com");
    expect(result.cookies).toEqual([
      { name: "a", value: "1", domain: ".iupana.com", path: "/" },
      { name: "b", value: "2", domain: ".iupana.com", path: "/" },
    ]);
  });

  it("devuelve cookies:[] si está whitelisteado pero sin cookie sincronizada", async () => {
    const result = await getStructuredCookies("iupana.com", fakeKv(null));
    expect(result).toEqual({ whitelisted: true, domain: "iupana.com", cookies: [] });
  });

  it("preserva valores de cookie que contienen '=' (ej. base64/JWT)", async () => {
    const result = await getStructuredCookies("iupana.com", fakeKv("sid=abc=def=="));
    expect(result.cookies).toEqual([{ name: "sid", value: "abc=def==", domain: ".iupana.com", path: "/" }]);
  });
});

describe("addDomainAndSync", () => {
  it("revierte un dominio nuevo cuando Safari no tiene una cookie para ese sitio", async () => {
    const configPath = tempConfig(["example.com"]);

    const result = await addDomainAndSync("fs.blog", {
      configPath,
      sync: async () => ({ ok: true, output: "[sync-safari-cookies] fs.blog: sin cookies relevantes en Safari" }),
    });

    expect(result).toMatchObject({ added: false, synced: false, reason: "no_cookie" });
    expect(configuredDomains(configPath)).toEqual(["example.com"]);
  });

  it("revierte un dominio nuevo cuando falla el sincronizador", async () => {
    const configPath = tempConfig(["example.com"]);

    const result = await addDomainAndSync("fs.blog", {
      configPath,
      sync: async () => ({ ok: false, output: "timeout esperando la sincronización" }),
    });

    expect(result).toMatchObject({ added: false, synced: false, reason: "sync_failed" });
    expect(configuredDomains(configPath)).toEqual(["example.com"]);
  });

  it("no expone la salida potencialmente sensible del sincronizador", async () => {
    const configPath = tempConfig();

    const result = await addDomainAndSync("fs.blog", {
      configPath,
      sync: async () => ({ ok: false, output: "falló con token=super-secret" }),
    });

    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it("persiste un dominio nuevo solo cuando la cookie quedó sincronizada", async () => {
    const configPath = tempConfig(["example.com"]);

    const result = await addDomainAndSync("fs.blog", {
      configPath,
      sync: async () => ({ ok: true, output: "[sync-safari-cookies] fs.blog: cookie actualizada (123 chars, ttl 86400s)" }),
    });

    expect(result).toMatchObject({ added: true, synced: true, reason: "synced" });
    expect(configuredDomains(configPath)).toEqual(["example.com", "fs.blog"]);
  });
});

describe("runCookieJarSync", () => {
  it("usa el LaunchAgent autorizado y devuelve solo el resultado nuevo del dominio", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jano-cookie-sync-test-"));
    tempDirs.push(dir);
    const outputPath = join(dir, "sync.out.log");
    writeFileSync(outputPath, "[sync-safari-cookies] fs.blog: sin cookies relevantes en Safari\n");
    let kickstarts = 0;

    const result = await runCookieJarSync("fs.blog", {
      outputPath,
      kickstart: async () => {
        kickstarts++;
        appendFileSync(outputPath, "[sync-safari-cookies] fs.blog: cookie actualizada (1135 chars, ttl 86400s)\n");
        return { ok: true, output: "" };
      },
      wait: async () => {},
      timeoutMs: 10,
    });

    expect(kickstarts).toBe(1);
    expect(result).toEqual({
      ok: true,
      output: "[sync-safari-cookies] fs.blog: cookie actualizada (1135 chars, ttl 86400s)\n",
    });
  });

  it("no reutiliza un éxito viejo si la corrida nueva informa que no hay cookie", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jano-cookie-sync-test-"));
    tempDirs.push(dir);
    const outputPath = join(dir, "sync.out.log");
    writeFileSync(outputPath, "[sync-safari-cookies] fs.blog: cookie actualizada (999 chars, ttl 86400s)\n");

    const result = await runCookieJarSync("fs.blog", {
      outputPath,
      kickstart: async () => {
        appendFileSync(outputPath, "[sync-safari-cookies] fs.blog: sin cookies relevantes en Safari\n");
        return { ok: true, output: "" };
      },
      wait: async () => {},
      timeoutMs: 10,
    });

    expect(result.output).toBe("[sync-safari-cookies] fs.blog: sin cookies relevantes en Safari\n");
  });
});
