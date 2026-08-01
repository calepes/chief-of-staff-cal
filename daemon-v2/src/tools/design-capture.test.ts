import { describe, it, expect } from "vitest";
import { captureDesignScreenshot } from "./design-capture.js";

describe("captureDesignScreenshot — validación de esquema", () => {
  it("rechaza file:// sin intentar lanzar el navegador", async () => {
    await expect(captureDesignScreenshot("file:///etc/passwd", [])).rejects.toThrow(/http/i);
  });

  it("rechaza javascript: sin intentar lanzar el navegador", async () => {
    await expect(captureDesignScreenshot("javascript:alert(1)", [])).rejects.toThrow(/http/i);
  });

  it("rechaza data: sin intentar lanzar el navegador", async () => {
    await expect(captureDesignScreenshot("data:text/html,<script>alert(1)</script>", [])).rejects.toThrow(/http/i);
  });
});
