import { describe, it, expect } from "vitest";
import { parseContacts, serializeContact } from "./whatsapp.js";

const SAMPLE_MD = `# WhatsApp Contacts

## Mafer López
- **Alias:** Mafer
- **Relación:** Agente de viajes (vuelos Bolivia/Perú)
- **Número:** +59172345678

## Noe García
- **Alias:** Noe
- **Relación:** Pareja
- **Número:** +59177654321
`;

describe("parseContacts", () => {
  it("parsea dos contactos del markdown", () => {
    const contacts = parseContacts(SAMPLE_MD);
    expect(contacts).toHaveLength(2);
  });

  it("parsea nombre, alias, relación y número", () => {
    const [mafer] = parseContacts(SAMPLE_MD);
    expect(mafer.nombre).toBe("Mafer López");
    expect(mafer.alias).toBe("Mafer");
    expect(mafer.relacion).toBe("Agente de viajes (vuelos Bolivia/Perú)");
    expect(mafer.numero).toBe("59172345678");
  });

  it("número sin + al parsear", () => {
    const [, noe] = parseContacts(SAMPLE_MD);
    expect(noe.numero).toBe("59177654321");
    expect(noe.numero.startsWith("+")).toBe(false);
  });

  it("devuelve array vacío si no hay contactos", () => {
    expect(parseContacts("# WhatsApp Contacts\n")).toHaveLength(0);
  });

  it("ignora bloques sin número", () => {
    const md = "# WhatsApp Contacts\n\n## Sin Número\n- **Alias:** test\n";
    expect(parseContacts(md)).toHaveLength(0);
  });
});

describe("serializeContact", () => {
  it("serializa con todos los campos", () => {
    const result = serializeContact({
      nombre: "Mafer López",
      alias: "Mafer",
      relacion: "Agente de viajes",
      numero: "59172345678",
    });
    expect(result).toContain("## Mafer López");
    expect(result).toContain("**Alias:** Mafer");
    expect(result).toContain("**Relación:** Agente de viajes");
    expect(result).toContain("**Número:** +59172345678");
  });

  it("usa primera palabra como alias si no se provee", () => {
    const result = serializeContact({ nombre: "Pedro Sánchez", numero: "59170000000" });
    expect(result).toContain("**Alias:** Pedro");
  });

  it("omite relación si no se provee", () => {
    const result = serializeContact({ nombre: "Test", numero: "123" });
    expect(result).not.toContain("**Relación:**");
  });
});
