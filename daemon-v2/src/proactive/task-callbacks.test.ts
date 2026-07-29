import { describe, expect, it, vi } from "vitest";
import {
  applyTaskInput,
  handleTaskCallback,
  isTaskCallback,
  looksLikeName,
  parseTaskCallback,
  type TaskCallbackDeps,
  type TaskInputDeps,
} from "./task-callbacks.js";
import type { Card } from "./task-card.js";
import type { TaskPendingInput, TaskProposal } from "./task-types.js";
import { CAL_PERSON } from "./task-people.js";

const HOY = "2026-07-28"; // martes

function baseProposal(over: Partial<TaskProposal> = {}): TaskProposal {
  return {
    messageId: "m1",
    threadId: "t1",
    subject: "(Tarea) Revisar contrato",
    title: "Revisar contrato",
    from: "clepesqueur@bcp.com.bo",
    to: "carlos@lepesqueur.net",
    fechaRecepcion: HOY,
    resumen: "Revisar el contrato antes del cierre.",
    accionRequerida: "Revisar contrato",
    contextoRelevante: null,
    sinAccionClara: false,
    asignadoId: CAL_PERSON.id,
    asignadoNombre: CAL_PERSON.nombre,
    fecha: null,
    deadline: null,
    attachments: [],
    followupIds: [],
    ...over,
  };
}

/** Store en memoria con la misma superficie que TaskStore. */
function fakeStore(initial?: TaskProposal) {
  const proposals = new Map<string, TaskProposal>();
  let input: TaskPendingInput | null = null;
  if (initial) proposals.set("p1", initial);
  return {
    proposals,
    getInput: () => input,
    store: {
      async getProposal(_chat: number, id: string) {
        return proposals.get(id) ?? null;
      },
      async updateProposal(_chat: number, id: string, payload: TaskProposal) {
        proposals.set(id, payload);
      },
      async clearProposal(_chat: number, id: string) {
        proposals.delete(id);
      },
      async createProposal() {
        return "p1";
      },
      async setPendingInput(_chat: number, v: TaskPendingInput) {
        input = v;
      },
      async getPendingInput() {
        return input;
      },
      async clearPendingInput() {
        input = null;
      },
    } as any,
  };
}

function callbackDeps(over: Partial<TaskCallbackDeps> & { store: any }): TaskCallbackDeps {
  return {
    notionToken: "tok",
    today: () => HOY,
    log: () => {},
    editCard: vi.fn(async () => {}),
    createTask: vi.fn(async () => ({ url: "https://notion.so/x", adjuntosSubidos: 0, adjuntosTotal: 0 })),
    pendientes: () => 0,
    advanceQueue: vi.fn(async () => {}),
    postponeActive: vi.fn(async () => {}),
    ...over,
  } as TaskCallbackDeps;
}

describe("parseo de callbacks", () => {
  it("reconoce el prefijo tsk:", () => {
    expect(isTaskCallback("tsk:ok:p1")).toBe(true);
    expect(isTaskCallback("bklg:save:x")).toBe(false);
    expect(isTaskCallback(undefined)).toBe(false);
  });

  it("parsea acción, propuesta y argumento", () => {
    expect(parseTaskCallback("tsk:asgpick:p1:3")).toEqual({ action: "asgpick", proposalId: "p1", arg: "3" });
    expect(parseTaskCallback("tsk:ok:p1")).toEqual({ action: "ok", proposalId: "p1", arg: undefined });
    expect(parseTaskCallback("basura")).toBeNull();
  });

  it("ningún callback supera los 64 bytes de Telegram", () => {
    const peor = `tsk:asgpick:${"a".repeat(8)}:19`;
    expect(Buffer.byteLength(peor)).toBeLessThanOrEqual(64);
  });
});

describe("handleTaskCallback", () => {
  it("avisa cuando la propuesta ya no existe", async () => {
    const { store } = fakeStore();
    const editCard = vi.fn(async () => {});
    await handleTaskCallback(callbackDeps({ store, editCard }), 1, 10, "tsk:ok:p1");
    expect((editCard.mock.calls[0] as any)[1].text).toContain("expiró");
  });

  it("asgpick asigna la persona y vuelve a la tarjeta principal", async () => {
    const f = fakeStore(baseProposal());
    const editCard = vi.fn(async () => {});
    await handleTaskCallback(callbackDeps({ store: f.store, editCard }), 1, 10, "tsk:asgpick:p1:1");
    expect(f.proposals.get("p1")!.asignadoNombre).toBe("Lorena Velasco");
    const card = (editCard.mock.calls[0] as any)[1] as Card;
    expect(card.text).toContain("Lorena Velasco");
    expect(card.text).toContain("Tarea propuesta");
  });

  it("los atajos de fecha escriben el campo correcto", async () => {
    const f = fakeStore(baseProposal());
    const deps = callbackDeps({ store: f.store });
    await handleTaskCallback(deps, 1, 10, "tsk:fecs:p1:vie");
    expect(f.proposals.get("p1")!.fecha).toBe("2026-07-31");
    expect(f.proposals.get("p1")!.deadline).toBeNull();

    await handleTaskCallback(deps, 1, 10, "tsk:deds:p1:prox");
    expect(f.proposals.get("p1")!.deadline).toBe("2026-08-07");

    await handleTaskCallback(deps, 1, 10, "tsk:fecs:p1:no");
    expect(f.proposals.get("p1")!.fecha).toBeNull();
  });

  it("✅ crea la tarea, limpia la propuesta y avanza la cola", async () => {
    const f = fakeStore(baseProposal());
    const createTask = vi.fn(async () => ({ url: "https://notion.so/abc", adjuntosSubidos: 0, adjuntosTotal: 0 }));
    const advanceQueue = vi.fn(async () => {});
    const editCard = vi.fn(async () => {});
    await handleTaskCallback(
      callbackDeps({ store: f.store, createTask, advanceQueue, editCard }),
      1,
      10,
      "tsk:ok:p1",
    );
    expect(createTask).toHaveBeenCalledOnce();
    expect(f.proposals.has("p1")).toBe(false);
    expect(advanceQueue).toHaveBeenCalledOnce();
    // calls[0] es el "⏳ Creando la tarea…" que quita los botones; el resultado es el último.
    expect((editCard.mock.calls.at(-1) as any)[1].text).toContain("Tarea creada");
  });

  it("si Notion falla, la propuesta sobrevive y la cola NO avanza", async () => {
    const f = fakeStore(baseProposal());
    const createTask = vi.fn(async () => {
      throw new Error("notion 500");
    });
    const advanceQueue = vi.fn(async () => {});
    const editCard = vi.fn(async () => {});
    await handleTaskCallback(
      callbackDeps({ store: f.store, createTask, advanceQueue, editCard }),
      1,
      10,
      "tsk:ok:p1",
    );
    expect(f.proposals.has("p1")).toBe(true);
    expect(advanceQueue).not.toHaveBeenCalled();
    const card = (editCard.mock.calls.at(-1) as any)[1] as Card;
    expect(card.text).toContain("No pude crear la tarea");
    expect(card.keyboard.inline_keyboard[0]![0]!.callback_data).toBe("tsk:ok:p1");
  });

  it("❌ descarta sin escribir en Notion y avanza", async () => {
    const f = fakeStore(baseProposal());
    const createTask = vi.fn(async () => ({ url: "x", adjuntosSubidos: 0, adjuntosTotal: 0 }));
    const advanceQueue = vi.fn(async () => {});
    await handleTaskCallback(
      callbackDeps({ store: f.store, createTask, advanceQueue }),
      1,
      10,
      "tsk:no:p1",
    );
    expect(createTask).not.toHaveBeenCalled();
    expect(f.proposals.has("p1")).toBe(false);
    expect(advanceQueue).toHaveBeenCalledOnce();
  });

  it("⏭️ Después manda la propuesta al final de la cola sin borrarla", async () => {
    const f = fakeStore(baseProposal());
    const postponeActive = vi.fn(async () => {});
    await handleTaskCallback(
      callbackDeps({ store: f.store, postponeActive, pendientes: () => 2 }),
      1,
      10,
      "tsk:later:p1",
    );
    expect(f.proposals.has("p1")).toBe(true);
    expect(postponeActive).toHaveBeenCalledOnce();
  });

  it("antes de crear quita el teclado con un ⏳ — es la protección real contra el doble tap", async () => {
    const f = fakeStore(baseProposal());
    const editCard = vi.fn(async () => {});
    let cardsAlEmpezar = 0;
    const createTask = vi.fn(async () => {
      // Durante todo el trabajo (adjuntos + Notion, puede pasar los 60s del lock) la tarjeta ya
      // no puede tener botones: si los tuviera, un segundo tap crearía una segunda página.
      cardsAlEmpezar = editCard.mock.calls.length;
      const ultima = (editCard.mock.calls.at(-1) as any)[1] as Card;
      expect(ultima.text).toContain("Creando la tarea");
      expect(ultima.keyboard.inline_keyboard).toEqual([]);
      return { url: "https://notion.so/abc", adjuntosSubidos: 0, adjuntosTotal: 0 };
    });

    await handleTaskCallback(callbackDeps({ store: f.store, createTask, editCard }), 1, 10, "tsk:ok:p1");
    expect(cardsAlEmpezar).toBe(1);
    expect((editCard.mock.calls.at(-1) as any)[1].text).toContain("Tarea creada");
  });

  it("informa cuando un adjunto no se pudo subir en vez de darlo por guardado", async () => {
    const f = fakeStore(baseProposal({ attachments: [
      { filename: "a.pdf", mimeType: "application/pdf", attachmentId: "x" },
      { filename: "b.pdf", mimeType: "application/pdf", attachmentId: "y" },
    ] }));
    const editCard = vi.fn(async () => {});
    const createTask = vi.fn(async () => ({ url: "u", adjuntosSubidos: 1, adjuntosTotal: 2 }));

    await handleTaskCallback(callbackDeps({ store: f.store, createTask, editCard }), 1, 10, "tsk:ok:p1");

    expect((editCard.mock.calls.at(-1) as any)[1].text).toContain("1 de 2 adjuntos");
  });

  it("cada tarjeta manda su teclado explícito (nunca se omite reply_markup)", async () => {
    const f = fakeStore(baseProposal());
    const editCard = vi.fn(async () => {});
    const deps = callbackDeps({ store: f.store, editCard });
    for (const data of ["tsk:back:p1", "tsk:asg:p1:0", "tsk:fec:p1", "tsk:ded:p1", "tsk:asgw:p1"]) {
      await handleTaskCallback(deps, 1, 10, data);
    }
    for (const call of editCard.mock.calls) {
      expect((call as any)[1].keyboard.inline_keyboard).toBeDefined();
    }
  });
});

describe("applyTaskInput", () => {
  function inputDeps(store: any, over: Partial<TaskInputDeps> = {}): TaskInputDeps {
    return {
      store,
      notionToken: "tok",
      today: () => HOY,
      log: () => {},
      pendientes: () => 0,
      clearKeyboard: vi.fn(async () => {}),
      sendCard: vi.fn(async () => {}),
      ...over,
    } as TaskInputDeps;
  }

  it("sin input pendiente no consume nada", async () => {
    const f = fakeStore(baseProposal());
    expect(await applyTaskInput(inputDeps(f.store), 1, "hola")).toBe(false);
  });

  it("aplica una fecha escrita y republica la tarjeta debajo del mensaje de Cal", async () => {
    const f = fakeStore(baseProposal());
    await f.store.setPendingInput(1, { proposalId: "p1", field: "fecha", anchorMessageId: 10 });
    const clearKeyboard = vi.fn(async () => {});
    const sendCard = vi.fn(async () => {});
    const consumido = await applyTaskInput(inputDeps(f.store, { clearKeyboard, sendCard }), 1, "15/9");

    expect(consumido).toBe(true);
    expect(f.proposals.get("p1")!.fecha).toBe("2026-09-15");
    expect(clearKeyboard).toHaveBeenCalledWith(10);
    expect((sendCard.mock.calls[0] as any)[0].text).toContain("2026-09-15");
    expect(f.getInput()).toBeNull();
  });

  it("un mensaje que no es fecha NO se consume — sigue al agente", async () => {
    const f = fakeStore(baseProposal());
    await f.store.setPendingInput(1, { proposalId: "p1", field: "fecha", anchorMessageId: 10 });
    const sendCard = vi.fn(async () => {});
    const consumido = await applyTaskInput(
      inputDeps(f.store, { sendCard }),
      1,
      "resume la reunión de ayer con Lorena",
    );
    expect(consumido).toBe(false);
    expect(sendCard).not.toHaveBeenCalled();
    // El pendiente sigue vivo: la tarjeta conserva su ⬅️ Atrás y Cal puede reintentar.
    expect(f.getInput()).not.toBeNull();
  });

  it("resuelve una persona del snapshot sin tocar Notion", async () => {
    const f = fakeStore(baseProposal());
    await f.store.setPendingInput(1, { proposalId: "p1", field: "asignado", anchorMessageId: 10 });
    const sendCard = vi.fn(async () => {});
    const consumido = await applyTaskInput(inputDeps(f.store, { sendCard }), 1, "lorena");
    expect(consumido).toBe(true);
    expect(f.proposals.get("p1")!.asignadoNombre).toBe("Lorena Velasco");
  });

  it("un nombre desconocido se consume pero repregunta — nunca asigna a quien no era", async () => {
    const f = fakeStore(baseProposal());
    await f.store.setPendingInput(1, { proposalId: "p1", field: "asignado", anchorMessageId: 10 });
    const sendCard = vi.fn(async () => {});
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchFn);
    const consumido = await applyTaskInput(inputDeps(f.store, { sendCard }), 1, "Zutano");
    vi.unstubAllGlobals();

    expect(consumido).toBe(true);
    expect(f.proposals.get("p1")!.asignadoNombre).toBe("CAL");
    expect((sendCard.mock.calls[0] as any)[0].text).toContain("No encontré esa persona");
  });

  it("esperando una persona, una frase larga tampoco se consume (ni consulta Notion)", async () => {
    const f = fakeStore(baseProposal());
    await f.store.setPendingInput(1, { proposalId: "p1", field: "asignado", anchorMessageId: 10 });
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    const consumido = await applyTaskInput(inputDeps(f.store), 1, "che, cancelá eso y mandame el resumen");
    vi.unstubAllGlobals();

    expect(consumido).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("looksLikeName", () => {
  it("acepta nombres y rechaza frases", () => {
    expect(looksLikeName("Lorena")).toBe(true);
    expect(looksLikeName("Maria Elena Canahua")).toBe(true);
    expect(looksLikeName("dame el resumen de la reunión")).toBe(false);
    expect(looksLikeName("¿quién es?")).toBe(false);
    expect(looksLikeName("")).toBe(false);
  });

  it("rechaza cortesías de una palabra que sí parecen nombres", () => {
    // Todas pasan el filtro "una palabra, solo letras" — sin la lista se consumían, gastando
    // una query a Notion y comiéndose el mensaje de Cal.
    for (const t of ["gracias", "ok", "listo", "dale", "hola", "perfecto", "ya"]) {
      expect(looksLikeName(t)).toBe(false);
    }
  });
});

describe("cancelar el input pendiente", () => {
  it("'cancelar' cierra la espera y devuelve la tarjeta, sin aplicar nada", async () => {
    const f = fakeStore(baseProposal());
    await f.store.setPendingInput(1, { proposalId: "p1", field: "asignado", anchorMessageId: 10 });
    const sendCard = vi.fn(async () => {});
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);

    const consumido = await applyTaskInput(
      {
        store: f.store,
        notionToken: "tok",
        today: () => HOY,
        log: () => {},
        pendientes: () => 0,
        clearKeyboard: vi.fn(async () => {}),
        sendCard,
      } as TaskInputDeps,
      1,
      "cancelar",
    );
    vi.unstubAllGlobals();

    expect(consumido).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(f.proposals.get("p1")!.asignadoNombre).toBe("CAL");
    expect((sendCard.mock.calls[0] as any)[0].text).toContain("Tarea propuesta");
    expect(f.getInput()).toBeNull();
  });
});
