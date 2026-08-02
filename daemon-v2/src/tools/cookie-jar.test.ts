import { describe, it, expect } from "vitest";
import type { CfKv } from "../cf-kv.js";
import { matchesDomain, isDomainAllowed, getStructuredCookies } from "./cookie-jar.js";

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
