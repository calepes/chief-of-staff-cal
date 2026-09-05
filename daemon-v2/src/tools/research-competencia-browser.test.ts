import { describe, it, expect } from "vitest";
import { findFreePort } from "./research-competencia-browser.js";

// `openResearchBrowserSession` (spawn de Chrome real + CDP) no tiene test acá — mismo criterio que
// `boa-checkin/src/browser.ts`, que tampoco lo testea: es integración real contra un binario del
// sistema, no lógica propia. `findFreePort` sí es pura E/O testeable sin mocks.
describe("findFreePort", () => {
  it("returns a port number in the valid TCP range", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);
  });

  it("returns different ports on consecutive calls (no double-bind)", async () => {
    const a = await findFreePort();
    const b = await findFreePort();
    expect(a).not.toBe(b);
  });
});
