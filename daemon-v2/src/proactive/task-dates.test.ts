import { describe, expect, it } from "vitest";
import {
  addDays,
  dayOfWeek,
  fridayNextWeek,
  fridayThisWeek,
  nextWeekday,
  parseWrittenDate,
  resolveShortcut,
  shortLabel,
} from "./task-dates.js";

// 2026-07-28 es martes — la fecha real en la que se diseñaron los atajos con Cal.
const MARTES = "2026-07-28";

describe("aritmética de calendario", () => {
  it("suma días cruzando fin de mes y fin de año", () => {
    expect(addDays("2026-07-28", 4)).toBe("2026-08-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("respeta años bisiestos", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("dayOfWeek usa 0=domingo", () => {
    expect(dayOfWeek(MARTES)).toBe(2);
    expect(dayOfWeek("2026-08-02")).toBe(0);
  });
});

describe("atajos de la tarjeta", () => {
  it("un martes, 'esta semana' es el viernes de esa misma semana", () => {
    expect(fridayThisWeek(MARTES)).toBe("2026-07-31");
    expect(fridayNextWeek(MARTES)).toBe("2026-08-07");
  });

  it("un viernes, 'esta semana' es hoy mismo", () => {
    expect(fridayThisWeek("2026-07-31")).toBe("2026-07-31");
  });

  it("nunca propone una fecha pasada: en sábado salta al viernes siguiente", () => {
    const sabado = "2026-08-01";
    expect(dayOfWeek(sabado)).toBe(6);
    expect(fridayThisWeek(sabado)).toBe("2026-08-07");
    expect(fridayThisWeek(sabado) > sabado).toBe(true);
  });

  it("resolveShortcut mapea los 4 botones", () => {
    expect(resolveShortcut("hoy", MARTES)).toBe(MARTES);
    expect(resolveShortcut("vie", MARTES)).toBe("2026-07-31");
    expect(resolveShortcut("prox", MARTES)).toBe("2026-08-07");
    expect(resolveShortcut("no", MARTES)).toBeNull();
  });

  it("shortLabel arma el dd/mm de los botones", () => {
    expect(shortLabel("2026-07-31")).toBe("31/07");
    expect(shortLabel("2026-08-07")).toBe("07/08");
  });
});

describe("parseWrittenDate", () => {
  it("acepta ISO", () => {
    expect(parseWrittenDate("2026-09-15", MARTES)).toEqual({ date: "2026-09-15" });
  });

  it("acepta dd/mm y dd/mm/yyyy", () => {
    expect(parseWrittenDate("15/9", MARTES)).toEqual({ date: "2026-09-15" });
    expect(parseWrittenDate("05/09/2027", MARTES)).toEqual({ date: "2027-09-05" });
    expect(parseWrittenDate("5-9-27", MARTES)).toEqual({ date: "2027-09-05" });
  });

  it("sin año, una fecha ya pasada se entiende como del año siguiente", () => {
    expect(parseWrittenDate("2/1", "2026-12-28")).toEqual({ date: "2027-01-02" });
    expect(parseWrittenDate("2/1", MARTES)).toEqual({ date: "2027-01-02" });
  });

  it("acepta relativas y días de la semana", () => {
    expect(parseWrittenDate("hoy", MARTES)).toEqual({ date: MARTES });
    expect(parseWrittenDate("mañana", MARTES)).toEqual({ date: "2026-07-29" });
    expect(parseWrittenDate("pasado mañana", MARTES)).toEqual({ date: "2026-07-30" });
    expect(parseWrittenDate("viernes", MARTES)).toEqual({ date: "2026-07-31" });
    expect(parseWrittenDate("el miercoles", MARTES)).toEqual({ date: "2026-07-29" });
    expect(parseWrittenDate("próximo viernes", MARTES)).toEqual({ date: "2026-08-07" });
  });

  it("distingue 'sin fecha' (limpia) de 'no entendí' (null)", () => {
    expect(parseWrittenDate("sin fecha", MARTES)).toEqual({ date: null });
    expect(parseWrittenDate("ninguna", MARTES)).toEqual({ date: null });
  });

  it("devuelve null ante cualquier cosa que no sea una fecha — así el mensaje sigue al LLM", () => {
    // Este es el caso que protege el chat: si acá saliera algo, el interceptor se comería un
    // pedido real de Cal (el gotcha que ya pasó con el modo journal).
    expect(parseWrittenDate("dame el resumen de la reunión de ayer", MARTES)).toBeNull();
    expect(parseWrittenDate("gracias", MARTES)).toBeNull();
    expect(parseWrittenDate("", MARTES)).toBeNull();
    expect(parseWrittenDate("31/02", MARTES)).toBeNull();
    expect(parseWrittenDate("99/99/9999", MARTES)).toBeNull();
  });
});
