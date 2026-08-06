import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@cos/shared", () => ({
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  sendRichMessage: vi.fn(async () => ({ message_id: 2 })),
}));

import { sendMessage, sendRichMessage } from "@cos/shared";
import { sendCronMessage } from "./rich-send.js";

beforeEach(() => {
  vi.mocked(sendMessage).mockClear();
  vi.mocked(sendRichMessage).mockClear();
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
