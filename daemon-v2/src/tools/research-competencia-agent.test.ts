import { describe, it, expect } from "vitest";
import { buildEntityPrompt, parseAgentJson } from "./research-competencia-agent.js";
import { getEntity } from "./research-competencia-entities.js";

describe("buildEntityPrompt", () => {
  it("incluye el nombre de la entidad, el timeframe y la query de LinkedIn", () => {
    const entity = getEntity("takenos");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null, adsText: null, historyText: null }, 7);
    expect(prompt).toContain("Takenos");
    expect(prompt).toContain("últimos 7 días");
    expect(prompt).toContain(entity.linkedinQuery);
  });

  it("marca explícito cuando no hay baseline (primera corrida)", () => {
    const entity = getEntity("meru");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null, adsText: null, historyText: null }, 7);
    expect(prompt).toContain("sin baseline — primera corrida");
  });

  it("incluye el baseline serializado cuando existe", () => {
    const entity = getEntity("meru");
    const baseline = { entityId: "meru", updatedAt: "2026-08-01T00:00:00Z", notas: "vio rol de Growth" };
    const prompt = buildEntityPrompt(entity, baseline, { ios: null, android: null, siteText: null, socialText: null, adsText: null, historyText: null }, 7);
    expect(prompt).toContain("vio rol de Growth");
  });

  it("pide un battlecard con nivel de amenaza para Yape", () => {
    const entity = getEntity("meru");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null, adsText: null, historyText: null }, 7);
    expect(prompt).toContain("battlecard");
    expect(prompt).toContain("amenaza");
  });

  it("exige que el battlecard nunca quede vacío aunque no haya hallazgos nuevos", () => {
    const entity = getEntity("meru");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null, adsText: null, historyText: null }, 7);
    expect(prompt).toContain("NUNCA deben quedar vacíos");
  });

  it("pide repetir del baseline las fortalezas/debilidades que siguen vigentes, sin re-verificar", () => {
    const entity = getEntity("meru");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null, adsText: null, historyText: null }, 7);
    expect(prompt).toContain("REPETILAS tal cual");
  });

  it("incluye el texto de RRSS en el prompt y lo declara como fuente citable", () => {
    const entity = getEntity("takenos");
    const prompt = buildEntityPrompt(
      entity, null,
      { ios: null, android: null, siteText: null, socialText: "[instagram @takenosapp.bo · 2026-09-01] https://instagram.com/p/x\nCaption: Promo nueva", adsText: null, historyText: null },
      7,
    );
    expect(prompt).toContain("Promo nueva");
    expect(prompt).toContain("redes sociales");
    expect(prompt).toContain("URL del post");
  });

  it("la REGLA DURA de fuentes incluye la URL de un post de RRSS como procedencia válida", () => {
    const entity = getEntity("meru");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null, adsText: null, historyText: null }, 7);
    const reglaDura = prompt.split("REGLA DURA sobre fuentes")[1];
    expect(reglaDura).toContain("post de RRSS");
  });

  it("no duplica el texto de RRSS: aparece una sola vez en todo el prompt", () => {
    const entity = getEntity("takenos");
    const marca = "[instagram @takenosapp.bo · 2026-09-01] https://instagram.com/p/x — Caption única de esta corrida";
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: marca, adsText: null, historyText: null }, 7);
    const ocurrencias = prompt.split(marca).length - 1;
    expect(ocurrencias).toBe(1);
  });

  it("incluye el texto de ads en el prompt, distinguiéndolo del orgánico", () => {
    const entity = getEntity("bancosol-altoke");
    const marca = "[google-ads · Banco Solidario S.A.] https://adstransparency.google.com/advertiser/AR1/creative/CR1?region=BO · CAMPAÑA NUEVA en esta ventana";
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null, adsText: marca, historyText: null }, 7);
    expect(prompt).toContain(marca);
    expect(prompt).toContain("Publicidad PAGA");
    expect(prompt).toContain("DISTINTO del contenido orgánico");
  });

  it("marca explícito que la ausencia de ads no es señal (evita que se use como debilidad)", () => {
    const entity = getEntity("meru");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null, adsText: null, historyText: null }, 7);
    expect(prompt).toContain("No lo interpretes como una señal en ningún sentido");
  });

  it("incluye Pricing como dimensión, con ejemplos concretos de tarifas/comisiones/tipo de cambio", () => {
    const entity = getEntity("meru");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null, adsText: null, historyText: null }, 7);
    expect(prompt).toContain("dimensión Pricing");
    expect(prompt).toContain("tipo de cambio preferencial");
  });

  it("la clasificación de hallazgos de RRSS incluye el criterio de Pricing", () => {
    const entity = getEntity("meru");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null, adsText: null, historyText: null }, 7);
    expect(prompt).toContain("Pricing si es una tarifa/comisión/tipo de cambio nuevo o distinto");
  });

  it("incluye el contexto estático de Yape (posicionamiento, features, tarifas) antes del baseline", () => {
    const entity = getEntity("meru");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null, adsText: null, historyText: null }, 7);
    expect(prompt).toContain("la aplicación de pagos N°1 de Bolivia");
    expect(prompt).toContain("yape.com.bo");
    expect(prompt.indexOf("Contexto de Yape")).toBeLessThan(prompt.indexOf("Estado anterior conocido (baseline)"));
  });

  it("instruye comparar contra Yape solo cuando la comparación sea real, sin forzarla en cada hallazgo", () => {
    const entity = getEntity("meru");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null, adsText: null, historyText: null }, 7);
    expect(prompt).toContain("a diferencia de");
    expect(prompt).toContain("no la fuerces");
  });
});

describe("buildEntityPrompt — bloque de historial", () => {
  it("incluye el texto de historyText cuando viene presente", () => {
    const entity = getEntity("takenos");
    const prompt = buildEntityPrompt(
      entity, null,
      { ios: null, android: null, siteText: null, socialText: null, adsText: null, historyText: "12 posts detectados entre 2026-06-01 y 2026-09-01 — promedio 0.9 posts/semana." },
      7,
    );
    expect(prompt).toContain("12 posts detectados entre 2026-06-01 y 2026-09-01");
  });

  it("no rompe si historyText es null (entidad sin histórico todavía)", () => {
    const entity = getEntity("takenos");
    const prompt = buildEntityPrompt(entity, null, { ios: null, android: null, siteText: null, socialText: null, adsText: null, historyText: null }, 7);
    expect(prompt).toContain("sin histórico acumulado todavía");
  });
});

describe("parseAgentJson", () => {
  it("parsea un JSON limpio", () => {
    const result = parseAgentJson('{"hallazgos":[{"dimension":"Producto","descripcion":"Nueva versión","fuente":"https://x.com"}],"notas":"ok"}');
    expect(result.hallazgos).toEqual([{ dimension: "Producto", descripcion: "Nueva versión", fuente: "https://x.com" }]);
    expect(result.notas).toBe("ok");
  });

  it("extrae el JSON aunque venga rodeado de prosa", () => {
    const result = parseAgentJson('Acá está el resultado:\n{"hallazgos":[],"notas":"nada"}\nListo.');
    expect(result.hallazgos).toEqual([]);
    expect(result.notas).toBe("nada");
  });

  it("descarta hallazgos con dimensión inválida", () => {
    const result = parseAgentJson('{"hallazgos":[{"dimension":"Inventada","descripcion":"x","fuente":""}],"notas":""}');
    expect(result.hallazgos).toEqual([]);
  });

  it("acepta la dimensión Pricing", () => {
    const result = parseAgentJson('{"hallazgos":[{"dimension":"Pricing","descripcion":"Baja comisión de remesas","fuente":"https://x.com"}],"notas":""}');
    expect(result.hallazgos).toEqual([{ dimension: "Pricing", descripcion: "Baja comisión de remesas", fuente: "https://x.com" }]);
  });

  it("devuelve vacío si no hay JSON parseable", () => {
    const result = parseAgentJson("no hay nada acá");
    expect(result).toEqual({ hallazgos: [], notas: "", battlecard: { resumen: "", fortalezas: [], debilidades: [], amenaza: "media" } });
  });

  it("parsea el battlecard cuando viene completo, con fuente por cada punto", () => {
    const result = parseAgentJson(
      '{"hallazgos":[],"notas":"","battlecard":{"resumen":"Crece rápido en LatAm","fortalezas":[{"texto":"multi-moneda","fuente":"https://x.com"}],"debilidades":[{"texto":"poca marca en Bolivia","fuente":""}],"amenaza":"alta"}}',
    );
    expect(result.battlecard).toEqual({
      resumen: "Crece rápido en LatAm",
      fortalezas: [{ texto: "multi-moneda", fuente: "https://x.com" }],
      debilidades: [{ texto: "poca marca en Bolivia", fuente: "" }],
      amenaza: "alta",
    });
  });

  it("descarta puntos de fortalezas/debilidades sin campo texto", () => {
    const result = parseAgentJson('{"hallazgos":[],"notas":"","battlecard":{"fortalezas":[{"fuente":"https://x.com"}],"debilidades":[],"amenaza":"media"}}');
    expect(result.battlecard.fortalezas).toEqual([]);
  });

  it("si el battlecard viene inválido o ausente, usa defaults seguros (amenaza 'media')", () => {
    const result = parseAgentJson('{"hallazgos":[],"notas":"","battlecard":{"amenaza":"catastrófica"}}');
    expect(result.battlecard).toEqual({ resumen: "", fortalezas: [], debilidades: [], amenaza: "media" });
  });
});
