# Spec: WhatsApp Link Skill

**Fecha:** 2026-05-08  
**Estado:** Aprobado  
**Canales:** Claude Code CLI · claude.ai/code · Jano · Vesta · Yapito (futuro)

---

## Objetivo

Generar links `wa.me` con mensaje pre-llenado para cualquier contacto guardado, desde cualquier canal donde Cal interactúa con Claude. Los contactos persisten en un archivo markdown compartido y se van enriqueciendo con el uso.

---

## Archivo de contactos

**Path:** `~/.claude/whatsapp-contacts.md`  
**Dueño:** compartido entre todos los canales (CLI y daemons leen/escriben el mismo archivo)

### Formato

```markdown
# WhatsApp Contacts

## Mafer López
- **Alias:** Mafer
- **Relación:** Agente de viajes (vuelos Bolivia/Perú)
- **Número:** +59172345678

## Noe García
- **Alias:** Noe
- **Relación:** Pareja
- **Número:** +59177654321
```

**Reglas del formato:**
- Número siempre en formato internacional sin espacios ni guiones: `+{CC}{número}`
- Nuevos contactos se agregan por append al final del archivo
- Un contacto por bloque `##`; los campos son fijos: Alias, Relación, Número

---

## Flujo de interacción (todos los canales)

### Paso 1 — Identificar contacto

Cal puede mencionar el contacto de varias formas:
- Por alias: "prepara WhatsApp para Mafer"
- Por nombre: "wa.me para Noe García"
- Sin especificar: "prepara WhatsApp" → mostrar lista completa

**Lógica de búsqueda:**
- Buscar en nombre completo y alias (case-insensitive, búsqueda parcial)
- **Match único** → usar directo, ir al paso 2
- **Sin match** → mostrar todos los contactos guardados y preguntar "¿A quién?" (lista numerada en CLI, botones inline en bots)
- **Múltiples matches** → mostrar solo los coincidentes y preguntar cuál. Ejemplo: "María" coincide con "María Fernanda" y "María José" → mostrar ambas con opción de elegir

### Paso 2 — Capturar mensaje

Preguntar o tomar del contexto:
- Si Cal ya proporcionó el texto en el mismo mensaje ("prepara WhatsApp para Mafer diciéndole que...") → usar ese texto
- Si no → preguntar "¿Qué mensaje quieres enviar?"
- El mensaje puede ser multilínea; se URL-encodea al generar el link

### Paso 3 — Generar link

```
https://wa.me/{número sin +}?text={mensaje URL-encoded}
```

Ejemplo: número `+59172345678`, mensaje `Hola Mafer, te comparto este vuelo`  
→ `https://wa.me/59172345678?text=Hola%20Mafer%2C%20te%20comparto%20este%20vuelo`

### Paso 4 — Entregar resultado

- **CLI / claude.ai:** mostrar el link completo listo para copiar, con nombre del contacto y preview del mensaje
- **Bots Telegram:** enviar el link como mensaje tapeable. Añadir botón "📋 Copiar" si el parse mode lo permite

### Paso 5 — Contacto nuevo (si aplica)

Si Cal elige crear un nuevo contacto durante el flujo:
1. Pedir nombre completo
2. Pedir alias (o confirmar si Cal ya lo mencionó)
3. Pedir relación con Cal
4. Pedir país → mapear a código: Bolivia=591, Perú=51, Argentina=54, Chile=56, Colombia=57, EEUU=1 (lista expandible)
5. Pedir número local (sin código de país)
6. Guardar en `~/.claude/whatsapp-contacts.md` por append
7. Confirmar: "✅ Mafer López guardada. Número: +59172345678"

---

## Componentes

### A) Skill CLI — `~/.claude/skills/whatsapp/SKILL.md`

Skill markdown que guía a Claude Code para:
1. Leer contactos via Bash: `cat ~/.claude/whatsapp-contacts.md`
2. Ejecutar el flujo de los 5 pasos
3. Escribir contacto nuevo via Bash append
4. Generar el link (string manipulation, no tool)

Se activa cuando Cal invoca `/whatsapp` o cuando el contexto de la conversación incluye "prepara WhatsApp", "wa.me", "link de WhatsApp".

### B) Tools en daemons — `tools/whatsapp.ts`

Misma lógica para Jano y Vesta (archivo idéntico, copiado). Yapito lo suma cuando esté activo.

```typescript
interface WaContact {
  nombre: string;
  alias?: string;    // opcional — si no se da, se usa la primera palabra del nombre
  relacion?: string; // opcional
  numero: string;    // formato internacional sin '+': "59172345678"
}

getWhatsappContacts(): Promise<WaContact[]>
// Lee ~/.claude/whatsapp-contacts.md, parsea todos los contactos, devuelve array

saveWhatsappContact(contact: WaContact): Promise<void>
// Append del nuevo contacto al archivo en formato estándar

// El link se genera en el LLM (no necesita tool):
// `https://wa.me/${contact.numero}?text=${encodeURIComponent(message)}`
```

**Integración en cada daemon:**
- `agent-tools.ts`: registrar `getWhatsappContacts` y `saveWhatsappContact` en `buildSdkTools`
- `system-prompt.ts`: agregar sección con instrucciones del flujo y mapeo de códigos de país
- `agent-tools.test.ts`: actualizar snapshot con los 2 nombres nuevos (orden alfabético)

---

## Manejo de errores

| Situación | Comportamiento |
|-----------|----------------|
| Archivo `~/.claude/whatsapp-contacts.md` no existe | Crear archivo vacío + ofrecer agregar primer contacto |
| Número inválido (no numérico, muy corto) | Rechazar y pedir de nuevo con ejemplo |
| País no reconocido | Pedir código de país directo (ej. "¿Código de país? Bolivia=591") |
| Match ambiguo y Cal no elige | Cancelar, mostrar la lista completa |

---

## Alcance fuera de scope

- Envío directo de mensajes via WhatsApp API (Business API) — fuera de scope, requiere cuenta Business
- Historial de mensajes enviados
- Templates de mensaje por contacto (puede agregarse en v2 si hay demanda)
