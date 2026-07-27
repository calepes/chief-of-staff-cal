import { describe, it, expect } from "vitest";
import { isLightCallback } from "./callback-router.js";

describe("isLightCallback", () => {
  it("los callbacks del journal NO son light — escriben en Notion", () => {
    expect(isLightCallback("jnl:apply:ab12")).toBe(false);
    expect(isLightCallback("jnl:resonate:cd34")).toBe(false);
    expect(isLightCallback("jnl:mode:close")).toBe(false);
    expect(isLightCallback("j:journal")).toBe(false);
  });

  it("los de navegación siguen siendo light", () => {
    expect(isLightCallback("menu:health")).toBe(true);
    expect(isLightCallback("nav:main")).toBe(true);
  });
});
