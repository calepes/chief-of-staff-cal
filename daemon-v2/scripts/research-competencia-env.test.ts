import { describe, it, expect } from "vitest";
import { findMissingEnvVars, formatMissingEnvError, REQUIRED_ENV_VARS } from "./research-competencia-env.js";

const FULL_ENV = { OPENROUTER_API_KEY: "a", ELEVENLABS_API_KEY: "b", NOTIF_BOT_TOKEN: "c" };

describe("findMissingEnvVars", () => {
  it("no devuelve nada si las 3 vars están presentes", () => {
    expect(findMissingEnvVars(FULL_ENV)).toEqual([]);
  });

  it("detecta una var faltante puntual", () => {
    const { ELEVENLABS_API_KEY, ...sinEleven } = FULL_ENV;
    expect(findMissingEnvVars(sinEleven).map((v) => v.key)).toEqual(["ELEVENLABS_API_KEY"]);
  });

  it("detecta las 3 faltantes con env vacío", () => {
    expect(findMissingEnvVars({}).map((v) => v.key)).toEqual(REQUIRED_ENV_VARS.map((v) => v.key));
  });

  it("una var vacía ('') cuenta como faltante, no como presente", () => {
    expect(findMissingEnvVars({ ...FULL_ENV, NOTIF_BOT_TOKEN: "" }).map((v) => v.key)).toEqual(["NOTIF_BOT_TOKEN"]);
  });
});

describe("formatMissingEnvError", () => {
  it("lista cada var faltante con su hint, una por línea", () => {
    const msg = formatMissingEnvError([{ key: "FOO", hint: "para X" }, { key: "BAR", hint: "para Y" }]);
    expect(msg).toContain("FOO: para X");
    expect(msg).toContain("BAR: para Y");
  });
});
