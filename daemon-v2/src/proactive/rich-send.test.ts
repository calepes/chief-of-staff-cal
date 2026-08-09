import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@cos/shared", () => ({
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  sendRichMessage: vi.fn(async () => ({ message_id: 2 })),
  editMessage: vi.fn(async () => undefined),
  editRichMessage: vi.fn(async () => undefined),
}));

import { sendMessage, sendRichMessage, editMessage, editRichMessage } from "@cos/shared";
import { sendCronMessage, editCronMessage, stripHtmlTags } from "./rich-send.js";

beforeEach(() => {
  vi.mocked(sendMessage).mockClear();
  vi.mocked(sendRichMessage).mockClear();
  vi.mocked(editMessage).mockClear();
  vi.mocked(editRichMessage).mockClear();
});

describe("sendCronMessage", () => {
  it("manda con sendRichMessage cuando funciona, sin caer a sendMessage", async () => {
    const result = await sendCronMessage("tok", { chatId: 1, text: "<b>hola</b>" });

    expect(result).toEqual({ message_id: 2 });
    expect(sendRichMessage).toHaveBeenCalledWith("tok", { chatId: 1, html: "<b>hola</b>", replyMarkup: undefined });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("pasa replyMarkup a sendRichMessage", async () => {
    const keyboard = { inline_keyboard: [[{ text: "OK", callback_data: "ok" }]] };
    await sendCronMessage("tok", { chatId: 1, text: "hola", replyMarkup: keyboard });

    expect(sendRichMessage).toHaveBeenCalledWith("tok", { chatId: 1, html: "hola", replyMarkup: keyboard });
  });

  it("cae a sendMessage con HTML clásico si sendRichMessage falla", async () => {
    vi.mocked(sendRichMessage).mockRejectedValueOnce(new Error("rich parse error"));

    const result = await sendCronMessage("tok", { chatId: 1, text: "<b>hola</b>" });

    expect(result).toEqual({ message_id: 1 });
    expect(sendMessage).toHaveBeenCalledWith("tok", {
      chatId: 1,
      text: "<b>hola</b>",
      parseMode: "HTML",
      replyMarkup: undefined,
    });
  });

  it("propaga el error si el fallback a sendMessage también falla", async () => {
    vi.mocked(sendRichMessage).mockRejectedValueOnce(new Error("rich parse error"));
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error("network down"));

    await expect(sendCronMessage("tok", { chatId: 1, text: "hola" })).rejects.toThrow("network down");
  });
});

describe("editCronMessage", () => {
  it("edita con editRichMessage cuando funciona, sin caer a editMessage", async () => {
    await editCronMessage("tok", { chatId: 1, messageId: 99, text: "<b>hola</b>" });

    expect(editRichMessage).toHaveBeenCalledWith("tok", 1, 99, "<b>hola</b>", undefined);
    expect(editMessage).not.toHaveBeenCalled();
  });

  it("pasa replyMarkup a editRichMessage", async () => {
    const keyboard = { inline_keyboard: [[{ text: "OK", callback_data: "ok" }]] };
    await editCronMessage("tok", { chatId: 1, messageId: 99, text: "hola", replyMarkup: keyboard });

    expect(editRichMessage).toHaveBeenCalledWith("tok", 1, 99, "hola", keyboard);
  });

  it("cae a editMessage con HTML clásico si editRichMessage falla", async () => {
    vi.mocked(editRichMessage).mockRejectedValueOnce(new Error("rich parse error"));

    await editCronMessage("tok", { chatId: 1, messageId: 99, text: "<b>hola</b>" });

    expect(editMessage).toHaveBeenCalledWith("tok", 1, 99, "<b>hola</b>", "HTML", undefined);
  });

  it("propaga el error si el fallback a editMessage también falla", async () => {
    vi.mocked(editRichMessage).mockRejectedValueOnce(new Error("rich parse error"));
    vi.mocked(editMessage).mockRejectedValueOnce(new Error("network down"));

    await expect(editCronMessage("tok", { chatId: 1, messageId: 99, text: "hola" })).rejects.toThrow("network down");
  });
});

describe("stripHtmlTags", () => {
  it("despoja tags simples y decodifica entidades", () => {
    expect(stripHtmlTags("<b>hola &amp; chau</b>")).toBe("hola & chau");
  });

  it("convierte <br> a salto de línea real", () => {
    expect(stripHtmlTags("línea 1<br>línea 2<br/>línea 3")).toBe("línea 1\nlínea 2\nlínea 3");
  });

  it("inserta bullet en <li> y salto tras </li>", () => {
    expect(stripHtmlTags("<ul><li>uno</li><li>dos</li></ul>")).toBe("• uno\n• dos");
  });

  it("inserta separador ' · ' tras </td> y </th> (fila de tabla no queda pegada)", () => {
    expect(stripHtmlTags("<table><tr><th>Formato</th><th>Hora</th></tr><tr><td>2D</td><td>14:00</td></tr></table>")).toBe(
      "Formato · Hora · \n2D · 14:00 ·",
    );
  });

  it("inserta salto tras headings y párrafos", () => {
    expect(stripHtmlTags("<h2>Título</h2><p>Cuerpo</p>")).toBe("Título\nCuerpo");
  });

  it("colapsa 3+ saltos de línea a 2 y hace trim", () => {
    expect(stripHtmlTags("  <p>a</p>\n\n\n\n<p>b</p>  ")).toBe("a\n\nb");
  });

  it("no rompe con texto sin ninguna tag", () => {
    expect(stripHtmlTags("texto plano sin formato")).toBe("texto plano sin formato");
  });
});
