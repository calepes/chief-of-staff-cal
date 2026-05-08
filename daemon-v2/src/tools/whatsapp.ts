import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const CONTACTS_PATH = `${homedir()}/.claude/whatsapp-contacts.md`;

export interface WaContact {
  nombre: string;
  alias?: string;
  relacion?: string;
  numero: string; // sin '+', ej: "59172345678"
}

export function parseContacts(markdown: string): WaContact[] {
  const contacts: WaContact[] = [];
  const blocks = markdown.split(/^## /m).slice(1);
  for (const block of blocks) {
    const lines = block.split("\n");
    const nombre = lines[0].trim();
    if (!nombre) continue;
    const get = (field: string) => {
      const line = lines.find((l) => l.toLowerCase().includes(`**${field.toLowerCase()}:**`));
      return line ? line.replace(/^.*\*\*[^*]+:\*\*\s*/, "").trim() : undefined;
    };
    const numero = get("Número")?.replace(/^\+/, "") ?? "";
    if (!numero) continue;
    contacts.push({ nombre, alias: get("Alias"), relacion: get("Relación"), numero });
  }
  return contacts;
}

export function serializeContact(c: WaContact): string {
  const alias = c.alias ?? c.nombre.split(" ")[0];
  const lines = [`\n## ${c.nombre}`, `- **Alias:** ${alias}`];
  if (c.relacion) lines.push(`- **Relación:** ${c.relacion}`);
  lines.push(`- **Número:** +${c.numero}`);
  return lines.join("\n") + "\n";
}

export async function getWhatsappContacts(): Promise<WaContact[]> {
  if (!existsSync(CONTACTS_PATH)) return [];
  const content = await readFile(CONTACTS_PATH, "utf-8");
  return parseContacts(content);
}

export async function saveWhatsappContact(contact: WaContact): Promise<void> {
  if (!existsSync(CONTACTS_PATH)) {
    await writeFile(CONTACTS_PATH, "# WhatsApp Contacts\n", "utf-8");
  }
  const entry = serializeContact(contact);
  const current = await readFile(CONTACTS_PATH, "utf-8");
  await writeFile(CONTACTS_PATH, current.trimEnd() + "\n" + entry, "utf-8");
}
