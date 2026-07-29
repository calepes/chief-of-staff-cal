import { describe, expect, it } from "vitest";
import {
  PEOPLE_PAGES,
  PEOPLE_PER_PAGE,
  renderAskInput,
  renderCreated,
  renderDatePicker,
  renderDiscarded,
  renderExpired,
  renderPeoplePicker,
  renderProposal,
  type Card,
} from "./task-card.js";
import { TASK_PEOPLE, CAL_PERSON } from "./task-people.js";
import type { TaskProposal } from "./task-types.js";

const HOY = "2026-07-28"; // martes

function proposal(over: Partial<TaskProposal> = {}): TaskProposal {
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
    deadline: "2026-08-01",
    attachments: [],
    followupIds: [],
    ...over,
  };
}

/** Límites duros de Telegram + la guía del skill telegram-bot-ux. */
function assertKeyboardSane(card: Card) {
  expect(card.keyboard.inline_keyboard.length).toBeLessThanOrEqual(4);
  for (const fila of card.keyboard.inline_keyboard) {
    expect(fila.length).toBeLessThanOrEqual(3);
    for (const b of fila) {
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
      expect(b.text.length).toBeLessThanOrEqual(20);
    }
  }
}

describe("renderProposal", () => {
  it("muestra asignado, fecha y deadline, con — para lo que falta", () => {
    const { text } = renderProposal(proposal(), { pendientes: 0, proposalId: "p1" });
    expect(text).toContain("👤 CAL");
    expect(text).toContain("📅 Fecha: —");
    expect(text).toContain("⏰ Deadline: 2026-08-01");
  });

  it("muestra el contador de cola solo si hay algo esperando", () => {
    expect(renderProposal(proposal(), { pendientes: 2, proposalId: "p1" }).text).toContain("Quedan 2 en la cola");
    expect(renderProposal(proposal(), { pendientes: 0, proposalId: "p1" }).text).not.toContain("cola");
  });

  it("ofrece ⏭️ Después solo cuando hay cola", () => {
    const conCola = renderProposal(proposal(), { pendientes: 1, proposalId: "p1" });
    const sinCola = renderProposal(proposal(), { pendientes: 0, proposalId: "p1" });
    const labels = (c: Card) => c.keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels(conCola)).toContain("⏭️ Después");
    expect(labels(sinCola)).not.toContain("⏭️ Después");
  });

  it("avisa de adjuntos y de correos de seguimiento", () => {
    const { text } = renderProposal(
      proposal({
        attachments: [{ filename: "a.pdf", mimeType: "application/pdf", attachmentId: "x" }],
        followupIds: ["m2"],
      }),
      { pendientes: 0, proposalId: "p1" },
    );
    expect(text).toContain("📎 1 adjunto");
    expect(text).toContain("1 correo posterior");
  });

  it("escapa HTML del asunto — un < en el título no puede romper el mensaje", () => {
    const { text } = renderProposal(proposal({ title: "Revisar <script> & cía" }), {
      pendientes: 0,
      proposalId: "p1",
    });
    expect(text).toContain("Revisar &lt;script&gt; &amp; cía");
  });

  it("respeta los límites de teclado de Telegram", () => {
    assertKeyboardSane(renderProposal(proposal(), { pendientes: 3, proposalId: "p1" }));
  });
});

describe("renderPeoplePicker", () => {
  it("pagina el snapshot completo sin dejar a nadie afuera", () => {
    const vistos = new Set<string>();
    for (let page = 0; page < PEOPLE_PAGES; page++) {
      const card = renderPeoplePicker(page, "p1");
      assertKeyboardSane(card);
      for (const fila of card.keyboard.inline_keyboard.slice(0, -1)) {
        for (const b of fila) vistos.add(b.callback_data);
      }
    }
    expect(vistos.size).toBe(TASK_PEOPLE.length);
  });

  it("muestra hasta 6 personas por página", () => {
    const card = renderPeoplePicker(0, "p1");
    const personas = card.keyboard.inline_keyboard.slice(0, -1).flat();
    expect(personas.length).toBeLessThanOrEqual(PEOPLE_PER_PAGE);
    expect(personas[0]!.text).toBe("CAL");
  });

  it("⏭️ Más cicla a la primera página al llegar al final", () => {
    const ultima = renderPeoplePicker(PEOPLE_PAGES - 1, "p1");
    const mas = ultima.keyboard.inline_keyboard.at(-1)!.find((b) => b.text === "⏭️ Más")!;
    const siguiente = renderPeoplePicker(Number(mas.callback_data.split(":")[3]), "p1");
    expect(siguiente.text).toContain(`Página 1 de ${PEOPLE_PAGES}`);
  });

  it("siempre ofrece el escape a texto libre (bloque B3 del skill)", () => {
    const escape = renderPeoplePicker(1, "p1").keyboard.inline_keyboard.at(-1)!;
    expect(escape.map((b) => b.text)).toContain("✍️ Otro");
    expect(escape.map((b) => b.text)).toContain("⬅️ Atrás");
  });
});

describe("renderDatePicker", () => {
  it("los atajos muestran la fecha real y escriben el campo correcto", () => {
    const fecha = renderDatePicker("fecha", HOY, "p1");
    const labels = fecha.keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain("📅 Hoy 28/07");
    expect(labels).toContain("📅 Vie 31/07");
    expect(labels).toContain("📅 Vie 07/08");
    expect(fecha.keyboard.inline_keyboard[0]![0]!.callback_data).toBe("tsk:fecs:p1:hoy");

    const deadline = renderDatePicker("deadline", HOY, "p1");
    expect(deadline.keyboard.inline_keyboard[0]![0]!.callback_data).toBe("tsk:deds:p1:hoy");
    expect(deadline.text).toContain("deadline");
  });

  it("respeta los límites de teclado", () => {
    assertKeyboardSane(renderDatePicker("fecha", HOY, "p1"));
  });
});

describe("tarjetas terminales y de espera", () => {
  it("la tarjeta creada enlaza a Notion y no deja botones vivos", () => {
    const card = renderCreated(proposal(), { url: "https://notion.so/abc", adjuntosSubidos: 0, adjuntosTotal: 0 }, 2);
    expect(card.text).toContain('<a href="https://notion.so/abc">');
    expect(card.text).toContain("quedan 2");
    expect(card.keyboard.inline_keyboard).toEqual([]);
  });

  it("descartada y expirada tampoco dejan botones", () => {
    expect(renderDiscarded(proposal(), 0).keyboard.inline_keyboard).toEqual([]);
    expect(renderExpired().keyboard.inline_keyboard).toEqual([]);
  });

  it("la pregunta de texto libre conserva ⬅️ Atrás para no dejar la tarjeta trabada", () => {
    for (const campo of ["asignado", "fecha", "deadline"] as const) {
      const card = renderAskInput(campo, "p1");
      expect(card.keyboard.inline_keyboard[0]![0]!.callback_data).toBe("tsk:back:p1");
      expect(card.text).toContain("✍️");
    }
  });
});
