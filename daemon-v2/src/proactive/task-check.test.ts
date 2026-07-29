import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./kpi-ingest-gmail.js", () => ({
  gmailAccessToken: vi.fn(async () => "atok"),
  searchTaskEmails: vi.fn(),
  getGmailMessage: vi.fn(),
  downloadGmailAttachmentBuffer: vi.fn(async () => Buffer.from("bytes")),
  archiveAndMarkRead: vi.fn(async () => undefined),
}));
vi.mock("./task-extract.js", () => ({ extractTaskFields: vi.fn() }));
vi.mock("./task-notion.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createTaskPage: vi.fn(),
    appendTaskFollowup: vi.fn(async () => undefined),
    notifyMissingDate: vi.fn(async () => undefined),
    uploadAttachmentToNotion: vi.fn(async () => "upload-1"),
  };
});
vi.mock("@cos/shared", () => ({ sendMessage: vi.fn(async () => ({ message_id: 1 })) }));

import {
  searchTaskEmails,
  getGmailMessage,
  archiveAndMarkRead,
  downloadGmailAttachmentBuffer,
} from "./kpi-ingest-gmail.js";
import { extractTaskFields } from "./task-extract.js";
import { createTaskPage, appendTaskFollowup, notifyMissingDate, uploadAttachmentToNotion } from "./task-notion.js";
import { sendMessage } from "@cos/shared";
import {
  advanceTaskQueue,
  checkTaskEmails,
  createTaskFromProposal,
  ensureActiveProposal,
  postponeActiveTask,
  readTaskCheckState,
  type CheckTaskEmailsOpts,
} from "./task-check.js";
import type { TaskProposal } from "./task-types.js";
import { CAL_PERSON } from "./task-people.js";

const gmailCreds = { clientId: "c", clientSecret: "s", refreshToken: "r" };
let tmpDir: string;
let statePath: string;
let store: ReturnType<typeof fakeStore>;

const baseExtract = {
  resumen: "Revisar el contrato con el proveedor X.",
  accionRequerida: "Leer el contrato y responder con comentarios.",
  contextoRelevante: null,
  deadline: "2026-08-01",
  fecha: "2026-07-30",
  sinAccionClara: false,
};

function fakeStore() {
  const proposals = new Map<string, TaskProposal>();
  let seq = 0;
  return {
    proposals,
    api: {
      async createProposal(_c: number, p: TaskProposal) {
        const id = `p${++seq}`;
        proposals.set(id, p);
        return id;
      },
      async getProposal(_c: number, id: string) {
        return proposals.get(id) ?? null;
      },
      async updateProposal(_c: number, id: string, p: TaskProposal) {
        proposals.set(id, p);
      },
      async clearProposal(_c: number, id: string) {
        proposals.delete(id);
      },
      async setPendingInput() {},
      async getPendingInput() {
        return null;
      },
      async clearPendingInput() {},
    } as any,
  };
}

function opts(): CheckTaskEmailsOpts {
  return { botToken: "t", chatId: 1, notionToken: "n", gmail: gmailCreds, store: store.api, statePath };
}

function mail(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    internalDate: new Date("2026-07-28T15:13:00Z").getTime(),
    attachments: [],
    subject: "(Tarea) Revisar contrato con proveedor",
    bodyText: "Por favor revisar el contrato adjunto.",
    threadId: "thread-1",
    ...over,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "task-check-test-"));
  statePath = join(tmpDir, "state.json");
  store = fakeStore();
  vi.clearAllMocks();
  vi.mocked(searchTaskEmails).mockResolvedValue([]);
  vi.mocked(extractTaskFields).mockResolvedValue(baseExtract);
  vi.mocked(createTaskPage).mockResolvedValue({ pageId: "page-1", url: "https://notion.so/page-1" });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("checkTaskEmails — propuesta, no creación", () => {
  it("propone la tarea en el chat y NO escribe nada en Notion todavía", async () => {
    vi.mocked(searchTaskEmails).mockResolvedValue([{ id: "m1" }] as any);
    vi.mocked(getGmailMessage).mockResolvedValue(mail() as any);

    await checkTaskEmails(opts());

    expect(createTaskPage).not.toHaveBeenCalled();
    expect(archiveAndMarkRead).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const [, msg] = vi.mocked(sendMessage).mock.calls[0] as any;
    expect(msg.text).toContain("Tarea propuesta");
    expect(msg.text).toContain("Revisar contrato con proveedor");
    expect(msg.replyMarkup.inline_keyboard[0][0].text).toBe("✅ Crear tarea");

    const state = readTaskCheckState(statePath);
    expect(state.processed).toContain("m1");
    expect(state.active?.item.messageId).toBe("m1");
    expect(state.threadPages).toEqual({});
  });

  it("con varios mails propone SOLO uno y encola el resto", async () => {
    vi.mocked(searchTaskEmails).mockResolvedValue([{ id: "m1" }, { id: "m2" }, { id: "m3" }] as any);
    vi.mocked(getGmailMessage).mockImplementation(async (id: string) =>
      mail({ id, threadId: `thread-${id}`, subject: `(Tarea) asunto ${id}` }) as any,
    );

    await checkTaskEmails(opts());

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const state = readTaskCheckState(statePath);
    expect(state.active?.item.messageId).toBe("m1");
    expect(state.queue.map((q) => q.messageId)).toEqual(["m2", "m3"]);

    const [, msg] = vi.mocked(sendMessage).mock.calls[0] as any;
    expect(msg.text).toContain("Quedan 2 en la cola");
  });

  it("un tick posterior no propone nada nuevo mientras haya una tarjeta activa", async () => {
    vi.mocked(searchTaskEmails).mockResolvedValue([{ id: "m1" }] as any);
    vi.mocked(getGmailMessage).mockImplementation(async (id: string) =>
      mail({ id, threadId: `thread-${id}` }) as any,
    );
    await checkTaskEmails(opts());
    vi.mocked(sendMessage).mockClear();

    vi.mocked(searchTaskEmails).mockResolvedValue([{ id: "m1" }, { id: "m2" }] as any);
    await checkTaskEmails(opts());

    expect(sendMessage).not.toHaveBeenCalled();
    expect(readTaskCheckState(statePath).queue.map((q) => q.messageId)).toEqual(["m2"]);
  });

  it("la Fecha de recepción usa el día calendario de La Paz (UTC-4), no el de UTC", async () => {
    vi.mocked(searchTaskEmails).mockResolvedValue([{ id: "m1" }] as any);
    // 2026-07-28 23:30 hora La Paz == 2026-07-29 03:30 UTC — un toISOString() directo fecharía
    // esto 07-29, que es el día equivocado para Cal.
    vi.mocked(getGmailMessage).mockResolvedValue(
      mail({ internalDate: new Date("2026-07-29T03:30:00Z").getTime() }) as any,
    );

    await checkTaskEmails(opts());

    const [, fechaRecepcion] = vi.mocked(extractTaskFields).mock.calls[0] as any;
    expect(fechaRecepcion).toBe("2026-07-28");
    expect([...store.proposals.values()][0]!.fechaRecepcion).toBe("2026-07-28");
  });

  it("si falla la síntesis, propone igual marcada sinAccionClara (nunca pierde el mail)", async () => {
    vi.mocked(searchTaskEmails).mockResolvedValue([{ id: "m1" }] as any);
    vi.mocked(getGmailMessage).mockResolvedValue(mail() as any);
    vi.mocked(extractTaskFields).mockResolvedValue(null);

    await checkTaskEmails(opts());

    const p = [...store.proposals.values()][0]!;
    expect(p.sinAccionClara).toBe(true);
    const [, msg] = vi.mocked(sendMessage).mock.calls[0] as any;
    expect(msg.text).toContain("no deja una acción concreta");
  });

  it("arranca con CAL como asignado", async () => {
    vi.mocked(searchTaskEmails).mockResolvedValue([{ id: "m1" }] as any);
    vi.mocked(getGmailMessage).mockResolvedValue(mail() as any);
    await checkTaskEmails(opts());
    expect([...store.proposals.values()][0]!.asignadoId).toBe(CAL_PERSON.id);
  });
});

describe("dedup por hilo", () => {
  it("un mail de un hilo YA convertido en tarea agrega seguimiento, no propone otra", async () => {
    writeFileSync(
      statePath,
      JSON.stringify({ processed: [], threadPages: { "thread-1": "page-9" }, queue: [], active: null, lastErrorNotified: {} }),
    );
    vi.mocked(searchTaskEmails).mockResolvedValue([{ id: "m2" }] as any);
    vi.mocked(getGmailMessage).mockResolvedValue(mail({ id: "m2" }) as any);

    await checkTaskEmails(opts());

    expect(appendTaskFollowup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appendTaskFollowup).mock.calls[0]![1]).toBe("page-9");
    expect(store.proposals.size).toBe(0);
    expect(readTaskCheckState(statePath).processed).toContain("m2");
  });

  it("un mail de un hilo con propuesta ACTIVA se anexa a esa propuesta, no crea otra tarjeta", async () => {
    vi.mocked(searchTaskEmails).mockResolvedValue([{ id: "m1" }] as any);
    vi.mocked(getGmailMessage).mockImplementation(async (id: string) => mail({ id }) as any);
    await checkTaskEmails(opts());
    vi.mocked(sendMessage).mockClear();

    vi.mocked(searchTaskEmails).mockResolvedValue([{ id: "m1" }, { id: "m2" }] as any);
    await checkTaskEmails(opts());

    expect(sendMessage).not.toHaveBeenCalled();
    const state = readTaskCheckState(statePath);
    expect(state.queue).toHaveLength(0);
    expect(state.active!.item.followupIds).toEqual(["m2"]);
    // El payload vivo también lo tiene: es de ahí que sale el bloque de seguimiento al crear.
    expect([...store.proposals.values()][0]!.followupIds).toEqual(["m2"]);
  });
});

describe("robustez del intake", () => {
  it("false positive de la búsqueda (subject sin el tag): processed sin reintentar ni notificar", async () => {
    vi.mocked(searchTaskEmails).mockResolvedValue([{ id: "m1" }] as any);
    vi.mocked(getGmailMessage).mockResolvedValue(mail({ subject: "Reporte diario" }) as any);

    await checkTaskEmails(opts());

    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.proposals.size).toBe(0);
    expect(readTaskCheckState(statePath).processed).toContain("m1");
  });

  it("no reprocesa un mensaje ya marcado como processed", async () => {
    writeFileSync(
      statePath,
      JSON.stringify({ processed: ["m1"], threadPages: {}, queue: [], active: null, lastErrorNotified: {} }),
    );
    vi.mocked(searchTaskEmails).mockResolvedValue([{ id: "m1" }] as any);

    await checkTaskEmails(opts());

    expect(getGmailMessage).not.toHaveBeenCalled();
  });

  it("un mail roto sale de la cola con aviso y el siguiente igual se propone", async () => {
    vi.mocked(searchTaskEmails).mockResolvedValue([{ id: "m1" }, { id: "m2" }] as any);
    vi.mocked(getGmailMessage)
      // intake de ambos
      .mockResolvedValueOnce(mail({ id: "m1", threadId: "t1" }) as any)
      .mockResolvedValueOnce(mail({ id: "m2", threadId: "t2" }) as any)
      // promoción: m1 se quedó sin cuerpo, m2 está bien
      .mockResolvedValueOnce(mail({ id: "m1", threadId: "t1", bodyText: "" }) as any)
      .mockResolvedValueOnce(mail({ id: "m2", threadId: "t2" }) as any);

    await checkTaskEmails(opts());

    const textos = vi.mocked(sendMessage).mock.calls.map((c) => (c[1] as any).text);
    expect(textos[0]).toContain("No pude preparar una tarea");
    expect(textos[1]).toContain("Tarea propuesta");
    const state = readTaskCheckState(statePath);
    expect(state.active?.item.messageId).toBe("m2");
    expect(state.queue).toHaveLength(0);
  });

  it("si falla el envío de la tarjeta, el mail queda en la cola y NO se marca activo", async () => {
    // Regresión del bloqueante encontrado por daemon-health-reviewer: con `active` seteado antes
    // del envío, un blip de red dejaba la cola trabada 7 días (el TTL del KV) sin ningún aviso.
    vi.mocked(searchTaskEmails).mockResolvedValue([{ id: "m1" }] as any);
    vi.mocked(getGmailMessage).mockImplementation(async (id: string) => mail({ id }) as any);
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error("connection reset"));

    await checkTaskEmails(opts());

    const state = readTaskCheckState(statePath);
    expect(state.active).toBeNull();
    expect(state.queue.map((q) => q.messageId)).toEqual(["m1"]);
    // La propuesta sintetizada se conserva y queda anotada en el ítem, para que el reintento no
    // vuelva a pagar Gmail + Sonnet (ver el test de "con Telegram caído...").
    expect(state.queue[0]!.proposalId).toBeDefined();

    // El próximo tick lo reintenta y esta vez sí queda propuesto.
    await checkTaskEmails(opts());
    expect(readTaskCheckState(statePath).active?.item.messageId).toBe("m1");
  });

  it("con Telegram caído no re-sintetiza: reusa la propuesta ya hecha", async () => {
    // Sin la caché, cada tick del cron (15 min) rehacía Gmail + Sonnet sobre el mismo correo
    // mientras durara el corte.
    vi.mocked(searchTaskEmails).mockResolvedValue([{ id: "m1" }] as any);
    vi.mocked(getGmailMessage).mockImplementation(async (id: string) => mail({ id }) as any);
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error("connection reset"));

    await checkTaskEmails(opts());
    expect(extractTaskFields).toHaveBeenCalledTimes(1);
    expect(readTaskCheckState(statePath).queue[0]!.proposalId).toBeDefined();

    vi.mocked(sendMessage).mockRejectedValueOnce(new Error("connection reset"));
    await checkTaskEmails(opts());
    expect(extractTaskFields).toHaveBeenCalledTimes(1); // no volvió a llamar al modelo

    await checkTaskEmails(opts()); // ya con red
    expect(extractTaskFields).toHaveBeenCalledTimes(1);
    expect(readTaskCheckState(statePath).active?.item.messageId).toBe("m1");
  });

  it("no rompe el poll completo si falla la búsqueda en Gmail", async () => {
    vi.mocked(searchTaskEmails).mockRejectedValue(new Error("gmail 500"));
    await expect(checkTaskEmails(opts())).resolves.toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("evita corridas superpuestas", async () => {
    let resolver: (v: any) => void = () => {};
    vi.mocked(searchTaskEmails).mockReturnValue(new Promise((r) => (resolver = r)) as any);
    const a = checkTaskEmails(opts());
    const b = checkTaskEmails(opts());
    resolver([]);
    await Promise.all([a, b]);
    expect(searchTaskEmails).toHaveBeenCalledTimes(1);
  });
});

describe("avance de la cola", () => {
  async function conCola() {
    vi.mocked(searchTaskEmails).mockResolvedValue([{ id: "m1" }, { id: "m2" }] as any);
    vi.mocked(getGmailMessage).mockImplementation(async (id: string) =>
      mail({ id, threadId: `thread-${id}`, subject: `(Tarea) asunto ${id}` }) as any,
    );
    await checkTaskEmails(opts());
    vi.mocked(sendMessage).mockClear();
  }

  it("advanceTaskQueue propone el siguiente de la cola", async () => {
    await conCola();
    await advanceTaskQueue(opts());

    const state = readTaskCheckState(statePath);
    expect(state.active?.item.messageId).toBe("m2");
    expect(state.queue).toHaveLength(0);
    expect((vi.mocked(sendMessage).mock.calls[0]![1] as any).text).toContain("asunto m2");
  });

  it("con la cola vacía, advanceTaskQueue no manda nada", async () => {
    vi.mocked(searchTaskEmails).mockResolvedValue([{ id: "m1" }] as any);
    vi.mocked(getGmailMessage).mockImplementation(async (id: string) => mail({ id }) as any);
    await checkTaskEmails(opts());
    vi.mocked(sendMessage).mockClear();

    await advanceTaskQueue(opts());

    expect(sendMessage).not.toHaveBeenCalled();
    expect(readTaskCheckState(statePath).active).toBeNull();
  });

  it("advanceTaskQueue de una propuesta que ya no es la activa no pisa la tarjeta nueva", async () => {
    // Carrera real: el handler borra la propuesta de KV y recién tras el edit de Telegram llama
    // advanceQueue; si un tick del cron cae en el medio, la declara expirada y promueve. Sin este
    // guard, el advance tardío pisaba esa tarjeta recién mandada y promovía OTRA — dos vivas.
    await conCola();
    const vieja = readTaskCheckState(statePath).active!.proposalId;
    await advanceTaskQueue(opts()); // el cron ya avanzó: ahora la activa es m2
    vi.mocked(sendMessage).mockClear();

    await advanceTaskQueue(opts(), vieja); // llega tarde el del callback

    expect(sendMessage).not.toHaveBeenCalled();
    expect(readTaskCheckState(statePath).active?.item.messageId).toBe("m2");
  });

  it("postponeActiveTask manda la activa al final y propone la siguiente", async () => {
    await conCola();
    await postponeActiveTask(opts());

    const state = readTaskCheckState(statePath);
    expect(state.active?.item.messageId).toBe("m2");
    expect(state.queue.map((q) => q.messageId)).toEqual(["m1"]);
  });

  it("una propuesta vencida en KV libera el turno y deja pasar a la siguiente", async () => {
    await conCola();
    const activeId = readTaskCheckState(statePath).active!.proposalId;
    store.proposals.delete(activeId); // simula el TTL de 7 días

    await ensureActiveProposal(opts());

    expect(readTaskCheckState(statePath).active?.item.messageId).toBe("m2");
  });
});

describe("createTaskFromProposal", () => {
  function proposal(over: Partial<TaskProposal> = {}): TaskProposal {
    return {
      messageId: "m1",
      threadId: "thread-1",
      subject: "(Tarea) Revisar contrato",
      title: "Revisar contrato",
      from: "clepesqueur@bcp.com.bo",
      to: "carlos@lepesqueur.net",
      fechaRecepcion: "2026-07-28",
      resumen: "Revisar el contrato.",
      accionRequerida: "Revisar",
      contextoRelevante: null,
      sinAccionClara: false,
      asignadoId: "person-99",
      asignadoNombre: "Lorena Velasco",
      fecha: "2026-07-31",
      deadline: "2026-08-07",
      attachments: [],
      followupIds: [],
      ...over,
    };
  }

  it("crea la página con el asignado elegido, archiva el mail y registra el hilo", async () => {
    const { url } = await createTaskFromProposal(opts(), proposal());

    expect(url).toBe("https://notion.so/page-1");
    const [, arg] = vi.mocked(createTaskPage).mock.calls[0] as any;
    expect(arg.asignadoId).toBe("person-99");
    expect(arg.fecha).toBe("2026-07-31");
    expect(arg.deadline).toBe("2026-08-07");
    expect(arg.body.preguntas).toEqual([]);
    expect(notifyMissingDate).not.toHaveBeenCalled();
    expect(archiveAndMarkRead).toHaveBeenCalledWith("m1", "atok");
    expect(readTaskCheckState(statePath).threadPages["thread-1"]).toBe("page-1");
  });

  it("sin Fecha ni Deadline agrega preguntas y notifica en Notion", async () => {
    await createTaskFromProposal(opts(), proposal({ fecha: null, deadline: null }));

    const [, arg] = vi.mocked(createTaskPage).mock.calls[0] as any;
    expect(arg.body.preguntas).toHaveLength(2);
    expect(notifyMissingDate).toHaveBeenCalledTimes(1);
  });

  it("sube los adjuntos recién al crear (no al proponer) y apenda los seguimientos", async () => {
    vi.mocked(getGmailMessage).mockResolvedValue(mail({ id: "m2", bodyText: "un dato más" }) as any);

    await createTaskFromProposal(
      opts(),
      proposal({
        attachments: [{ filename: "a.pdf", mimeType: "application/pdf", attachmentId: "att-1" }],
        followupIds: ["m2"],
      }),
    );

    expect(downloadGmailAttachmentBuffer).toHaveBeenCalledWith("m1", "att-1", "atok");
    expect(uploadAttachmentToNotion).toHaveBeenCalledTimes(1);
    const [, arg] = vi.mocked(createTaskPage).mock.calls[0] as any;
    expect(arg.body.attachments).toEqual([{ filename: "a.pdf", fileUploadId: "upload-1" }]);
    expect(appendTaskFollowup).toHaveBeenCalledTimes(1);
    // El mail de seguimiento también se archiva.
    expect(archiveAndMarkRead).toHaveBeenCalledWith("m2", "atok");
  });

  it("es idempotente por hilo: un segundo intento NO crea una página duplicada", async () => {
    // Regresión del bloqueante: el "🔄 Reintentar" tras un fallo parcial, o un doble tap una vez
    // vencido el lock de 60s mientras se suben adjuntos, creaba una SEGUNDA página en Notion.
    const primera = await createTaskFromProposal(opts(), proposal());
    const segunda = await createTaskFromProposal(opts(), proposal());

    expect(createTaskPage).toHaveBeenCalledTimes(1);
    expect(segunda.yaExistia).toBe(true);
    expect(segunda.url).toContain("page1"); // la URL de Notion va sin guiones
    expect(primera.yaExistia).toBeUndefined();
  });

  it("devuelve el conteo real de adjuntos subidos, no el del correo", async () => {
    vi.mocked(uploadAttachmentToNotion)
      .mockResolvedValueOnce("upload-1")
      .mockRejectedValueOnce(new Error("413 too large"));

    const res = await createTaskFromProposal(
      opts(),
      proposal({
        attachments: [
          { filename: "a.pdf", mimeType: "application/pdf", attachmentId: "att-1" },
          { filename: "b.pdf", mimeType: "application/pdf", attachmentId: "att-2" },
        ],
      }),
    );

    expect(res.adjuntosSubidos).toBe(1);
    expect(res.adjuntosTotal).toBe(2);
  });

  it("relee la propuesta para no perder un seguimiento llegado durante la creación", async () => {
    const p = proposal();
    const id = await store.api.createProposal(1, p);
    // El intake apenda un followup al payload vivo DESPUÉS de que el handler leyó `p`.
    await store.api.updateProposal(1, id, { ...p, followupIds: ["m9"] });
    vi.mocked(getGmailMessage).mockResolvedValue(mail({ id: "m9", bodyText: "un dato más" }) as any);

    await createTaskFromProposal(opts(), p, id);

    expect(appendTaskFollowup).toHaveBeenCalledTimes(1);
    expect(archiveAndMarkRead).toHaveBeenCalledWith("m9", "atok");
  });

  it("un fallo al archivar (falta scope gmail.modify) no rompe la creación", async () => {
    vi.mocked(archiveAndMarkRead).mockRejectedValue(new Error("403 insufficient scope"));
    await expect(createTaskFromProposal(opts(), proposal())).resolves.toMatchObject({
      url: "https://notion.so/page-1",
    });
  });
});
