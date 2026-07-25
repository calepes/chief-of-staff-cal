import { describe, it, expect } from "vitest";
import { matchesDomain, isDomainAllowed } from "./cookie-jar.js";

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
