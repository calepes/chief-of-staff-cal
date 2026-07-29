import { describe, it, expect, vi } from "vitest";
import {
  hasTareaTag,
  stripTareaTag,
  gmailPermalink,
  buildTaskBodyBlocks,
  createTaskPage,
  appendTaskFollowup,
  notifyMissingDate,
  uploadAttachmentToNotion,
  TAREAS_DB_ID,
  CAL_PEOPLE_PAGE_ID,
  CAL_NOTION_USER_ID,
} from "./task-notion.js";

describe("hasTareaTag", () => {
  it("detecta (Tarea) mayúscula", () => {
    expect(hasTareaTag("(Tarea) Revisar contrato con proveedor")).toBe(true);
  });
  it("detecta (tarea) minúscula en medio del subject", () => {
    expect(hasTareaTag("RV: (tarea) firmar documento")).toBe(true);
  });
  it("no detecta subjects sin el tag", () => {
    expect(hasTareaTag("Seguimiento Diario Yape Bolivia | 26/07/2026")).toBe(false);
  });
});

describe("stripTareaTag", () => {
  it("quita el tag y espacios sobrantes", () => {
    expect(stripTareaTag("(Tarea)  Revisar contrato con proveedor")).toBe("Revisar contrato con proveedor");
  });
  it("funciona con el tag en medio del subject", () => {
    expect(stripTareaTag("RV: (tarea) firmar documento")).toBe("RV: firmar documento");
  });
  it("no rompe un subject sin el tag", () => {
    expect(stripTareaTag("Sin tag acá")).toBe("Sin tag acá");
  });
});

describe("gmailPermalink", () => {
  it("arma el link #all (sobrevive al archivado, a diferencia de #inbox)", () => {
    expect(gmailPermalink("18abc123")).toBe("https://mail.google.com/mail/u/0/#all/18abc123");
  });
});

describe("buildTaskBodyBlocks", () => {
  const base = {
    from: "clepesqueur@bcp.com.bo",
    to: "carlos@lepesqueur.net",
    subject: "(Tarea) Revisar contrato",
    fechaRecepcion: "2026-07-28",
    resumen: "Revisar el contrato con el proveedor X.",
    accionRequerida: "Leer el contrato y responder con comentarios.",
    contextoRelevante: null as string | null,
    threadId: "t1",
    sinAccionClara: false,
    preguntas: [] as string[],
    attachments: [] as { filename: string; fileUploadId: string }[],
  };

  it("incluye Origen, bookmark al mail y Resumen/Acción sin secciones opcionales de más", () => {
    const blocks = buildTaskBodyBlocks(base);
    expect(blocks.find((b: any) => b.type === "bookmark")).toBeDefined();
    expect((blocks.find((b: any) => b.type === "bookmark") as any).bookmark.url).toBe(gmailPermalink("t1"));
    expect(blocks.some((b: any) => b.type === "heading_3" && b.heading_3.rich_text[0].text.content === "❓ Preguntas")).toBe(false);
    expect(blocks.some((b: any) => b.type === "heading_3" && b.heading_3.rich_text[0].text.content === "📎 Adjuntos")).toBe(false);
  });

  it("agrega la nota de revisión manual cuando sinAccionClara es true", () => {
    const blocks = buildTaskBodyBlocks({ ...base, sinAccionClara: true });
    expect(blocks.some((b: any) => b.type === "paragraph" && String(b.paragraph.rich_text[0].text.content).includes("revisión manual"))).toBe(true);
  });

  it("agrega sección Preguntas cuando hay preguntas", () => {
    const blocks = buildTaskBodyBlocks({ ...base, preguntas: ["¿Cuándo debería trabajarse esta tarea (Fecha)?"] });
    const headingIdx = blocks.findIndex((b: any) => b.type === "heading_3" && b.heading_3.rich_text[0].text.content === "❓ Preguntas");
    expect(headingIdx).toBeGreaterThanOrEqual(0);
    expect((blocks[headingIdx + 1] as any).bulleted_list_item.rich_text[0].text.content).toBe("¿Cuándo debería trabajarse esta tarea (Fecha)?");
  });

  it("agrega bloques file por cada adjunto", () => {
    const blocks = buildTaskBodyBlocks({ ...base, attachments: [{ filename: "doc.pdf", fileUploadId: "up1" }] });
    const fileBlock = blocks.find((b: any) => b.type === "file") as any;
    expect(fileBlock.file).toEqual({ type: "file_upload", file_upload: { id: "up1" }, name: "doc.pdf" });
  });
});

describe("createTaskPage", () => {
  it("crea la página con las properties correctas y el body inline", async () => {
    const calls: Array<{ method: string; url: string; body: any }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method: init?.method ?? "GET", url: String(url), body });
      return new Response(JSON.stringify({ id: "page-1", url: "https://notion.so/page-1" }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await createTaskPage(
      "tok",
      {
        title: "Revisar contrato",
        resumen: "Revisar el contrato con el proveedor X.",
        deadline: "2026-08-01",
        fecha: null,
        body: {
          from: "clepesqueur@bcp.com.bo",
          to: "carlos@lepesqueur.net",
          subject: "(Tarea) Revisar contrato",
          fechaRecepcion: "2026-07-28",
          resumen: "Revisar el contrato con el proveedor X.",
          accionRequerida: "Leer el contrato y responder con comentarios.",
          contextoRelevante: null,
          threadId: "t1",
          sinAccionClara: false,
          preguntas: [],
          attachments: [],
        },
      },
      fetchFn,
    );

    expect(result).toEqual({ pageId: "page-1", url: "https://notion.so/page-1" });
    const createCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/pages"));
    expect(createCall?.body.parent).toEqual({ database_id: TAREAS_DB_ID });
    expect(createCall?.body.properties["Nombre de tarea"]).toEqual({ title: [{ text: { content: "Revisar contrato" } }] });
    expect(createCall?.body.properties["Estado"]).toEqual({ status: { name: "Sin empezar" } });
    expect(createCall?.body.properties["Asignado a"]).toEqual({ relation: [{ id: CAL_PEOPLE_PAGE_ID }] });
    expect(createCall?.body.properties["Solicitado por"]).toEqual({ relation: [{ id: CAL_PEOPLE_PAGE_ID }] });
    expect(createCall?.body.properties["Deadline"]).toEqual({ date: { start: "2026-08-01" } });
    expect(createCall?.body.properties["Fecha"]).toBeUndefined();
  });

  it("lanza si Notion devuelve error", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(
      createTaskPage(
        "tok",
        {
          title: "T",
          resumen: "r",
          deadline: null,
          fecha: null,
          body: {
            from: "a",
            to: "b",
            subject: "s",
            fechaRecepcion: "2026-07-28",
            resumen: "r",
            accionRequerida: "a",
            contextoRelevante: null,
            threadId: "t1",
            sinAccionClara: false,
            preguntas: [],
            attachments: [],
          },
        },
        fetchFn,
      ),
    ).rejects.toThrow("401");
  });
});

describe("appendTaskFollowup", () => {
  it("hace PATCH a blocks/{pageId}/children con un bloque de seguimiento", async () => {
    const calls: Array<{ method: string; url: string; body: any }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method: init?.method ?? "GET", url: String(url), body });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    await appendTaskFollowup("tok", "page-1", { fechaRecepcion: "2026-07-29", resumen: "Nuevo mail del mismo thread." }, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toContain("/v1/blocks/page-1/children");
  });
});

describe("notifyMissingDate", () => {
  it("crea un comentario con @mención a Cal", async () => {
    const calls: Array<{ method: string; url: string; body: any }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method: init?.method ?? "GET", url: String(url), body });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    await notifyMissingDate("tok", "page-1", "falta Fecha/Deadline.", fetchFn);

    expect(calls[0].url).toContain("/v1/comments");
    expect(calls[0].body.parent).toEqual({ page_id: "page-1" });
    expect(calls[0].body.rich_text[0]).toEqual({ type: "mention", mention: { type: "user", user: { id: CAL_NOTION_USER_ID } } });
  });
});

describe("uploadAttachmentToNotion", () => {
  it("crea el file_upload y manda los bytes, devolviendo el id", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(url) });
      if (String(url).endsWith("/v1/file_uploads")) {
        return new Response(JSON.stringify({ id: "upload-1", upload_url: "x" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "upload-1", status: "uploaded" }), { status: 200 });
    }) as unknown as typeof fetch;

    const id = await uploadAttachmentToNotion("tok", { filename: "doc.pdf", mimeType: "application/pdf", bytes: Buffer.from("hola") }, fetchFn);

    expect(id).toBe("upload-1");
    expect(calls[0]).toEqual({ method: "POST", url: "https://api.notion.com/v1/file_uploads" });
    expect(calls[1]).toEqual({ method: "POST", url: "https://api.notion.com/v1/file_uploads/upload-1/send" });
  });

  it("lanza si falla el envío de bytes", async () => {
    const fetchFn = vi.fn(async (url: unknown) => {
      if (String(url).endsWith("/v1/file_uploads")) return new Response(JSON.stringify({ id: "upload-1" }), { status: 200 });
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;

    await expect(
      uploadAttachmentToNotion("tok", { filename: "doc.pdf", mimeType: "application/pdf", bytes: Buffer.from("x") }, fetchFn),
    ).rejects.toThrow("500");
  });
});
