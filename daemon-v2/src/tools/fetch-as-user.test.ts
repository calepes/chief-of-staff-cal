import { describe, expect, it, vi } from "vitest";
import { fetchAsUser, isPrivateMessagingUrl } from "./fetch-as-user.js";
import type { CfKv } from "../cf-kv.js";

describe("isPrivateMessagingUrl", () => {
  it("bloquea rutas de mensajería de cada plataforma", () => {
    expect(isPrivateMessagingUrl("https://facebook.com/messages")).toBe(true);
    expect(isPrivateMessagingUrl("https://facebook.com/messages/t/123")).toBe(true);
    expect(isPrivateMessagingUrl("https://messenger.com/")).toBe(true);
    expect(isPrivateMessagingUrl("https://messenger.com/t/123")).toBe(true);
    expect(isPrivateMessagingUrl("https://x.com/messages")).toBe(true);
    expect(isPrivateMessagingUrl("https://twitter.com/messages")).toBe(true);
    expect(isPrivateMessagingUrl("https://instagram.com/direct")).toBe(true);
    expect(isPrivateMessagingUrl("https://instagram.com/direct/t/123")).toBe(true);
    expect(isPrivateMessagingUrl("https://tiktok.com/messages")).toBe(true);
  });

  it("bloquea variantes con www. y con subdominios", () => {
    expect(isPrivateMessagingUrl("https://www.facebook.com/messages")).toBe(true);
    expect(isPrivateMessagingUrl("https://m.facebook.com/messages")).toBe(true);
    expect(isPrivateMessagingUrl("https://www.messenger.com")).toBe(true);
    expect(isPrivateMessagingUrl("https://www.x.com/messages")).toBe(true);
    expect(isPrivateMessagingUrl("https://mobile.twitter.com/messages")).toBe(true);
    expect(isPrivateMessagingUrl("https://www.instagram.com/direct")).toBe(true);
    expect(isPrivateMessagingUrl("https://www.tiktok.com/messages")).toBe(true);
  });

  it("bloquea intentos de evasión (mayúsculas, doble slash, dot-segment)", () => {
    expect(isPrivateMessagingUrl("https://facebook.com/MESSAGES")).toBe(true);
    expect(isPrivateMessagingUrl("https://facebook.com//messages")).toBe(true);
    expect(isPrivateMessagingUrl("https://facebook.com/./messages")).toBe(true);
    expect(isPrivateMessagingUrl("https://X.COM/MESSAGES")).toBe(true);
  });

  it("falla cerrado si el URL no parsea", () => {
    expect(isPrivateMessagingUrl("no-es-un-url")).toBe(true);
    expect(isPrivateMessagingUrl("")).toBe(true);
    expect(isPrivateMessagingUrl("   ")).toBe(true);
  });

  it("NO bloquea contenido público legítimo", () => {
    expect(isPrivateMessagingUrl("https://elpais.com/economia/2026-08-31/articulo.html")).toBe(false);
    expect(isPrivateMessagingUrl("https://x.com/algunusuario")).toBe(false);
    expect(isPrivateMessagingUrl("https://instagram.com/algunacuenta")).toBe(false);
    expect(isPrivateMessagingUrl("https://facebook.com/algunapagina")).toBe(false);
    expect(isPrivateMessagingUrl("https://tiktok.com/@alguien/video/123")).toBe(false);
  });

  it("no bloquea por falso positivo de substring (segmento distinto, no dominio ajeno)", () => {
    // path que empieza con "messages" pero no es exactamente ese segmento
    expect(isPrivateMessagingUrl("https://x.com/messages-de-prensa")).toBe(false);
    // dominio que contiene "facebook.com" como substring pero no como sufijo real
    expect(isPrivateMessagingUrl("https://notfacebook.com/messages")).toBe(false);
  });
});

describe("fetchAsUser — bloqueo de mensajería privada", () => {
  const fakeKv = {} as CfKv;

  it("no llama al fetch si el URL está bloqueado", async () => {
    const fetchSpy = vi.fn();
    const result = await fetchAsUser("https://facebook.com/messages/t/999", fakeKv, 15000, fetchSpy);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.text).toBe("");
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/mensajería privada/i);
  });

  it("sí llama al fetch para un URL no bloqueado", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response("<html><title>ok</title>hola</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const result = await fetchAsUser("https://x.com/algunusuario", fakeKv, 15000, fetchSpy);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
});
