import { describe, expect, it, vi } from "vitest";
import {
  CAL_PERSON,
  TASK_PEOPLE,
  findPersonInNotion,
  findPersonInSnapshot,
  normalizeName,
} from "./task-people.js";

describe("snapshot de People", () => {
  it("tiene 20 personas, sin ids repetidos, con CAL primero", () => {
    expect(TASK_PEOPLE).toHaveLength(20);
    expect(new Set(TASK_PEOPLE.map((p) => p.id)).size).toBe(20);
    expect(CAL_PERSON.nombre).toBe("CAL");
  });

  it("todos los ids son UUIDs de Notion", () => {
    for (const p of TASK_PEOPLE) {
      expect(p.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });
});

describe("normalizeName", () => {
  it("saca acentos, case y espacios de más", () => {
    expect(normalizeName("  Cinthia   IBAÑEZ ")).toBe("cinthia ibanez");
  });
});

describe("findPersonInSnapshot", () => {
  it("matchea nombre completo sin importar acentos ni case", () => {
    expect(findPersonInSnapshot("cinthia ibanez")?.nombre).toBe("Cinthia Ibañez");
    expect(findPersonInSnapshot("LORENA VELASCO")?.nombre).toBe("Lorena Velasco");
  });

  it("matchea por nombre de pila cuando es inequívoco", () => {
    expect(findPersonInSnapshot("dieter")?.nombre).toBe("Dieter Belmonte");
    expect(findPersonInSnapshot("matias")?.nombre).toBe("Matias Papini");
  });

  it("devuelve null si no está o si es ambiguo — nunca adivina", () => {
    expect(findPersonInSnapshot("Persona Inexistente")).toBeNull();
    expect(findPersonInSnapshot("")).toBeNull();
  });
});

describe("findPersonInNotion", () => {
  function fakeFetch(results: Array<{ id: string; nombre: string }>) {
    return vi.fn(async () =>
      new Response(
        JSON.stringify({
          results: results.map((r) => ({
            id: r.id,
            properties: { Name: { type: "title", title: [{ plain_text: r.nombre }] } },
          })),
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
  }

  it("devuelve la persona cuando hay exactamente una", async () => {
    const fetchFn = fakeFetch([{ id: "abc", nombre: "Pedro Nuevo" }]);
    const found = await findPersonInNotion("Pedro", { notionToken: "t", fetchFn });
    expect(found).toEqual({ id: "abc", nombre: "Pedro Nuevo" });
  });

  it("con varias coincidencias parciales, se queda con el match exacto", async () => {
    const fetchFn = fakeFetch([
      { id: "1", nombre: "Ana" },
      { id: "2", nombre: "Mariana Lopez" },
    ]);
    const found = await findPersonInNotion("Ana", { notionToken: "t", fetchFn });
    expect(found?.id).toBe("1");
  });

  it("devuelve null si es ambiguo o no hay nada", async () => {
    const ambiguo = fakeFetch([
      { id: "1", nombre: "Ana Perez" },
      { id: "2", nombre: "Ana Torres" },
    ]);
    expect(await findPersonInNotion("Ana", { notionToken: "t", fetchFn: ambiguo })).toBeNull();

    const vacio = fakeFetch([]);
    expect(await findPersonInNotion("Nadie", { notionToken: "t", fetchFn: vacio })).toBeNull();
  });

  it("filtra por la propiedad title real de la DB People ('Name', no 'Nombre')", async () => {
    const fetchFn = fakeFetch([{ id: "abc", nombre: "Pedro Nuevo" }]);
    await findPersonInNotion("Pedro", { notionToken: "t", fetchFn });
    const body = JSON.parse((fetchFn as any).mock.calls[0][1].body);
    expect(body.filter.property).toBe("Name");
  });
});
