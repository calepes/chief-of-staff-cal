import { describe, it, expect } from "vitest";
import { sevenDaysAgo, sweepDedupKey } from "./journal-sweep.js";

describe("sevenDaysAgo", () => {
  it("devuelve la fecha ISO de hace 7 días en hora de La Paz", () => {
    expect(sevenDaysAgo(new Date("2026-07-27T23:00:00.000Z"))).toBe("2026-07-20T19:00:00-04:00");
  });
});

describe("sweepDedupKey", () => {
  it("usa el día local como clave para no repetir el aviso esa semana", () => {
    expect(sweepDedupKey(new Date("2026-07-26T23:00:00.000Z"))).toBe("jano:journal:sweep:2026-07-26");
  });

  it("dos corridas del mismo día comparten clave", () => {
    expect(sweepDedupKey(new Date("2026-07-26T23:00:00.000Z"))).toBe(
      sweepDedupKey(new Date("2026-07-26T23:59:00.000Z")),
    );
  });
});
