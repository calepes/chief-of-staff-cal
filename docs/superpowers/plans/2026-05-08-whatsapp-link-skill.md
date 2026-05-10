# WhatsApp Link Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Crear un skill de WhatsApp disponible en CLI, Jano y Vesta que gestiona un directorio de contactos compartido y genera links `wa.me` con mensaje pre-llenado.

**Architecture:** Archivo compartido `~/.claude/whatsapp-contacts.md` como fuente de verdad. Skill markdown para CLI/claude.ai que usa Bash. Dos tools en cada daemon (`getWhatsappContacts` / `saveWhatsappContact`) que leen/escriben el mismo archivo. El link se genera inline por el LLM (string `https://wa.me/{num}?text={encoded}`).

**Tech Stack:** TypeScript (Node.js), Zod, Vitest, `node:fs/promises`, `node:os`

---

## File Map

| Acción | Archivo |
|--------|---------|
| Crear | `~/.claude/whatsapp-contacts.md` |
| Crear | `~/.claude/skills/whatsapp/SKILL.md` |
| Crear | `Jano/daemon-v2/src/tools/whatsapp.ts` |
| Crear | `Jano/daemon-v2/src/tools/whatsapp.test.ts` |
| Modificar | `Jano/daemon-v2/src/agent-tools.ts` |
| Modificar | `Jano/daemon-v2/src/system-prompt.ts` |
| Crear | `Vesta/daemon-v2/src/tools/whatsapp.ts` (copia) |
| Modificar | `Vesta/daemon-v2/src/agent-tools.ts` |
| Modificar | `Vesta/daemon-v2/src/system-prompt.ts` |

---

## Task 1: Archivo de contactos + Skill CLI

**Files:**
- Create: `~/.claude/whatsapp-contacts.md`
- Create: `~/.claude/skills/whatsapp/SKILL.md`

- [ ] **Crear el archivo de contactos vacío con header**

```bash
mkdir -p ~/.claude/skills/whatsapp
cat > ~/.claude/whatsapp-contacts.md << 'EOF'
# WhatsApp Contacts

EOF
```

- [ ] **Verificar que existe**

```bash
cat ~/.claude/whatsapp-contacts.md
```
Expected: `# WhatsApp Contacts` + línea vacía

- [ ] **Crear el skill SKILL.md**

```bash
cat > ~/.claude/skills/whatsapp/SKILL.md << 'SKILL'
---
name: whatsapp
description: Genera links wa.me con mensaje pre-llenado para contactos guardados. Gestiona un directorio local de contactos con nombre, alias, relación y número.
trigger: Invocar cuando Cal mencione "prepara WhatsApp", "wa.me", "link de WhatsApp", "mensaje para X por WhatsApp", o invoque /whatsapp.
---

# Skill: WhatsApp Link Generator

## Contactos

Los contactos viven en `~/.claude/whatsapp-contacts.md`. Leerlos siempre con:

```bash
cat ~/.claude/whatsapp-contacts.md
```

Formato del archivo:
```
# WhatsApp Contacts

## Nombre Completo
- **Alias:** alias
- **Relación:** relación con Cal
- **Número:** +CC##########
```

El número siempre en formato internacional sin espacios ni guiones: `+{CC}{número}`.

## Flujo

### Paso 1 — Identificar contacto

Buscar en nombre y alias (case-insensitive, parcial):

- **Match único** → usar, ir al Paso 2
- **Sin match** → listar todos los contactos numerados y preguntar "¿A quién?"
- **Múltiples matches** → mostrar solo los coincidentes numerados y preguntar cuál

### Paso 2 — Capturar mensaje

- Si Cal ya incluyó el texto en el mismo mensaje → usar ese texto
- Si no → preguntar "¿Qué mensaje quieres enviar?"

### Paso 3 — Generar link

```
https://wa.me/{número sin +}?text={mensaje URL-encoded}
```

Ejemplo: +59172345678 + "Hola Mafer" → `https://wa.me/59172345678?text=Hola%20Mafer`

Mostrar el link completo listo para copiar, con nombre del contacto y preview del mensaje.

### Paso 4 — Contacto nuevo (si aplica)

Si el contacto no existe y Cal quiere crearlo:
1. Pedir nombre completo
2. Pedir alias (opcional — default: primera palabra del nombre)
3. Pedir relación con Cal (opcional)
4. Pedir país → mapear a código: Bolivia=591, Perú=51, Argentina=54, Chile=56, Colombia=57, EEUU=1
5. Pedir número local (sin código de país, sin espacios)
6. Construir número completo: `+{CC}{número}`
7. Agregar al archivo con bash append:
```bash
cat >> ~/.claude/whatsapp-contacts.md << 'EOF'

## {Nombre Completo}
- **Alias:** {alias}
- **Relación:** {relacion}
- **Número:** +{CC}{número}
EOF
```
8. Confirmar: "✅ {Nombre} guardado. Número: +{CC}{número}"

## Manejo de errores

| Situación | Acción |
|-----------|--------|
| Archivo no existe | `touch ~/.claude/whatsapp-contacts.md` + ofrecer crear primer contacto |
| Número inválido (no numérico / < 7 dígitos) | Rechazar y pedir de nuevo con ejemplo |
| País no reconocido | Pedir código de país directo ("ej. Bolivia=591") |
| Match ambiguo y Cal no elige | Cancelar, mostrar lista completa |
SKILL
```

- [ ] **Verificar que el skill se cargó**

```bash
cat ~/.claude/skills/whatsapp/SKILL.md | head -5
```
Expected: `---` + `name: whatsapp`

---

## Task 2: Tool `whatsapp.ts` en Jano (con tests)

**Files:**
- Create: `Jano/daemon-v2/src/tools/whatsapp.ts`
- Create: `Jano/daemon-v2/src/tools/whatsapp.test.ts`

Las rutas relativas son desde `~/Claude Projects/Personal/Agents/Jano/`.

- [ ] **Escribir el test PRIMERO — `daemon-v2/src/tools/whatsapp.test.ts`**

Crear el archivo de test (la implementación no existe todavía):

```typescript
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
```

- [ ] **Correr el test para verificar que falla**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2"
npx vitest run src/tools/whatsapp.test.ts
```
Expected: FAIL — `Cannot find module './whatsapp.js'`

- [ ] **Crear la implementación — `daemon-v2/src/tools/whatsapp.ts`**

```typescript
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
      return line ? line.replace(/.*\*\*[^*]+\*\*:\s*/, "").trim() : undefined;
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
```

- [ ] **Correr el test con la implementación en su lugar**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2"
npx vitest run src/tools/whatsapp.test.ts
```
Expected: todos los tests en verde (10 tests PASS)

- [ ] **Verificar tipos TypeScript**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2"
npx tsc --noEmit
```
Expected: sin errores

---

## Task 3: Integrar en Jano (agent-tools + system-prompt + build)

**Files:**
- Modify: `Jano/daemon-v2/src/agent-tools.ts`
- Modify: `Jano/daemon-v2/src/system-prompt.ts`

- [ ] **Agregar import en `agent-tools.ts`** (después de los imports existentes)

```typescript
import { getWhatsappContacts, saveWhatsappContact, type WaContact } from "./tools/whatsapp.js";
```

- [ ] **Agregar `wapiKey` a `ToolDeps` si hace falta**

No hace falta — las tools de whatsapp no tienen deps externos. El archivo compartido usa `homedir()` directamente.

- [ ] **Registrar las dos tools en `buildSdkTools`** (al final del array, antes del `]`)

```typescript
    tool(
      "getWhatsappContacts",
      "Lista todos los contactos guardados en ~/.claude/whatsapp-contacts.md. Devuelve array de { nombre, alias?, relacion?, numero } donde numero es el número internacional sin '+' (ej: '59172345678'). Llamar cuando Cal quiera preparar un WhatsApp o buscar un contacto.",
      {},
      async () => asText(await getWhatsappContacts()),
      READ_ONLY,
    ),
    tool(
      "saveWhatsappContact",
      "Agrega un contacto nuevo a ~/.claude/whatsapp-contacts.md. Args: { nombre, alias?, relacion?, numero } donde numero es el número internacional sin '+' (ej: '59172345678'). Llamar después de confirmar los datos con Cal.",
      {
        nombre: z.string().describe("Nombre completo"),
        alias: z.string().optional().describe("Alias o apodo — default: primera palabra del nombre"),
        relacion: z.string().optional().describe("Relación con Cal — ej: Agente de viajes, Pareja"),
        numero: z.string().describe("Número internacional sin '+' ni espacios — ej: 59172345678"),
      },
      async (args) => asText(await saveWhatsappContact(args as WaContact)),
    ),
```

- [ ] **Agregar sección WhatsApp en `system-prompt.ts`**

Localizar la sección de tools (buscar donde se documentan tools como `getOutlookEvents` o `travelTime`). Agregar:

```
### WhatsApp

Cuando Cal pida preparar un mensaje de WhatsApp, link wa.me, o contactar a alguien por WhatsApp:
1. Llamar `getWhatsappContacts` para obtener la lista.
2. Si Cal menciona un nombre/alias, buscar match (case-insensitive, parcial).
   - Match único → usar directo
   - Sin match → listar todos y preguntar "¿A quién?"
   - Múltiples matches → listar solo los coincidentes y preguntar cuál
3. Preguntar el mensaje (o tomarlo del contexto si Cal ya lo dio).
4. Generar el link: `https://wa.me/{numero}?text={encodeURIComponent(mensaje)}`
5. Enviar el link al chat como mensaje tapeable.
6. Si el contacto no existe y Cal quiere crearlo: pedir nombre, alias (opcional), relación (opcional), país (Bolivia=591, Perú=51, Argentina=54, Chile=56, Colombia=57, EEUU=1) y número local → llamar `saveWhatsappContact`.
```

- [ ] **Build Jano**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2"
npm run build
```
Expected: sin errores de compilación

- [ ] **Correr tests completos de Jano**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2"
npx vitest run
```
Expected: todos en verde

- [ ] **Commit**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Jano"
git add daemon-v2/src/tools/whatsapp.ts daemon-v2/src/tools/whatsapp.test.ts daemon-v2/src/agent-tools.ts daemon-v2/src/system-prompt.ts
git commit -m "feat: add WhatsApp link tool (getWhatsappContacts + saveWhatsappContact)"
```

---

## Task 4: Replicar en Vesta

**Files:**
- Create: `Vesta/daemon-v2/src/tools/whatsapp.ts` (copia exacta de Jano)
- Modify: `Vesta/daemon-v2/src/agent-tools.ts`
- Modify: `Vesta/daemon-v2/src/system-prompt.ts`

- [ ] **Copiar `whatsapp.ts` de Jano a Vesta**

```bash
cp "/Users/calepes/Claude Projects/Personal/Agents/Jano/daemon-v2/src/tools/whatsapp.ts" \
   "/Users/calepes/Claude Projects/Personal/Agents/Vesta/daemon-v2/src/tools/whatsapp.ts"
```

- [ ] **Verificar que Vesta tiene estructura de tools similar**

```bash
ls "/Users/calepes/Claude Projects/Personal/Agents/Vesta/daemon-v2/src/tools/"
```
Expected: ver archivos existentes (maps.ts, reminders.ts, etc.) — confirmar que el directorio existe

- [ ] **Agregar import en `Vesta/daemon-v2/src/agent-tools.ts`**

Mismo import que en Jano:
```typescript
import { getWhatsappContacts, saveWhatsappContact, type WaContact } from "./tools/whatsapp.js";
```

- [ ] **Registrar las dos tools en `buildSdkTools` de Vesta**

Mismas definiciones exactas que en Jano (copiar los dos bloques `tool(...)` de Task 3):

```typescript
    tool(
      "getWhatsappContacts",
      "Lista todos los contactos guardados en ~/.claude/whatsapp-contacts.md. Devuelve array de { nombre, alias?, relacion?, numero } donde numero es el número internacional sin '+' (ej: '59172345678'). Llamar cuando alguien quiera preparar un WhatsApp o buscar un contacto.",
      {},
      async () => asText(await getWhatsappContacts()),
      READ_ONLY,
    ),
    tool(
      "saveWhatsappContact",
      "Agrega un contacto nuevo a ~/.claude/whatsapp-contacts.md. Args: { nombre, alias?, relacion?, numero } donde numero es el número internacional sin '+' (ej: '59172345678'). Llamar después de confirmar los datos con el usuario.",
      {
        nombre: z.string().describe("Nombre completo"),
        alias: z.string().optional().describe("Alias o apodo — default: primera palabra del nombre"),
        relacion: z.string().optional().describe("Relación con Cal — ej: Agente de viajes, Pareja"),
        numero: z.string().describe("Número internacional sin '+' ni espacios — ej: 59172345678"),
      },
      async (args) => asText(await saveWhatsappContact(args as WaContact)),
    ),
```

- [ ] **Agregar sección WhatsApp en `Vesta/daemon-v2/src/system-prompt.ts`**

Localizar sección de tools en Vesta y agregar (mismo contenido que Jano):

```
### WhatsApp

Cuando alguien pida preparar un mensaje de WhatsApp, link wa.me, o contactar a alguien por WhatsApp:
1. Llamar `getWhatsappContacts` para obtener la lista.
2. Buscar match por nombre/alias (case-insensitive, parcial).
   - Match único → usar directo
   - Sin match → listar todos y preguntar "¿A quién?"
   - Múltiples matches → listar solo los coincidentes y preguntar cuál
3. Preguntar el mensaje (o tomarlo del contexto).
4. Generar el link: `https://wa.me/{numero}?text={encodeURIComponent(mensaje)}`
5. Enviar el link al chat como mensaje tapeable.
6. Si el contacto no existe: pedir nombre, alias (opcional), relación (opcional), país (Bolivia=591, Perú=51, Argentina=54, Chile=56, Colombia=57, EEUU=1) y número local → llamar `saveWhatsappContact`.
```

- [ ] **Build Vesta**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Vesta/daemon-v2"
npm run build
```
Expected: sin errores de compilación

- [ ] **Commit Vesta**

```bash
cd "/Users/calepes/Claude Projects/Personal/Agents/Vesta"
git add daemon-v2/src/tools/whatsapp.ts daemon-v2/src/agent-tools.ts daemon-v2/src/system-prompt.ts
git commit -m "feat: add WhatsApp link tool (getWhatsappContacts + saveWhatsappContact)"
```

---

## Task 5: Agregar primer contacto y smoke test

- [ ] **Agregar contacto de Mafer manualmente (o via skill)**

```bash
cat >> ~/.claude/whatsapp-contacts.md << 'EOF'

## Mafer [Apellido]
- **Alias:** Mafer
- **Relación:** Agente de viajes (vuelos Bolivia/Perú)
- **Número:** +591XXXXXXXX
EOF
```
Reemplazar apellido y número real.

- [ ] **Smoke test CLI**

En una sesión de Claude Code, escribir:
```
prepara WhatsApp para Mafer diciéndole que ya tengo los datos del vuelo
```
Expected: Claude lee contactos, encuentra "Mafer", genera link `https://wa.me/591XXXXXXXX?text=ya%20tengo...`

- [ ] **Smoke test bot Jano**

Mandar al bot Jano en Telegram:
```
prepara wa.me para Mafer con: "Hola Mafer, te paso los datos del vuelo"
```
Expected: bot responde con el link tapeable

- [ ] **Smoke test contacto nuevo**

En CLI o Jano:
```
prepara WhatsApp para Juan Pérez
```
Expected: Claude no lo encuentra → pregunta → Cal da datos → se guarda → genera link

- [ ] **Verificar que Vesta también lo tiene**

Mandar en el chat de Vesta (o grupo familiar):
```
necesito el link de WhatsApp para Mafer
```
Expected: Vesta responde con el link

---

## Notas post-implementación

- **Yapito**: cuando el daemon de Yapito esté activo, copiar `whatsapp.ts` y registrar las tools siguiendo el mismo patrón de Jano (Task 3)
- El archivo `~/.claude/whatsapp-contacts.md` es el único punto de verdad — editarlo a mano funciona sin reiniciar daemons (se lee en cada llamada)
- Si hay que eliminar un contacto: editar el `.md` y borrar el bloque `##`
