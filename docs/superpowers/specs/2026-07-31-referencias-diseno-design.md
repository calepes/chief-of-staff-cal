# Referencias de Diseño — Diseño

**Fecha:** 2026-07-31
**Pedido de Cal:** encontrar recursos de diseño (X, Instagram, dashboards, artículos) y poder
guardarlos ordenados para inspirarse al rediseñar sus apps — sin saber todavía si el destino debía
ser Notion o el repo local. Además: que el mismo guardado funcione tanto mandándole el link a Jano
por Telegram como pasándoselo a Claude en una sesión interactiva de Claude Code.

## Decisiones tomadas

| Decisión | Elegido | Descartado |
|---|---|---|
| Consumidor principal | Claude, al rediseñar apps | Cal ojeando visualmente |
| Destino | Carpeta local en el repo | Notion (agrega latencia/rate-limit sin aportar nada si el consumidor es Claude) |
| Ubicación | `Personal/Referencias de Diseño/` (fuera de `Apps/`, que es solo para apps standalone) | Dentro de `Apps/` |
| Trabajo al guardar | Captura + análisis con visión, automático | Solo URL + nota · Captura con checkpoint antes de guardar |
| Login wall X/Instagram | Inyección de cookies del Cookie Broker al contexto de Playwright | Whitelist sin inyección real (no resuelve nada) · Fallback manual únicamente |

Por qué "Claude, al rediseñar" descarta Notion de raíz: un link a un tweet o un reel, leído por
Claude dentro de tres meses, no sirve — X e Instagram bloquean el fetch y, aunque no lo hicieran,
Claude no "ve" el diseño desde una URL sola. El valor está en lo que se extrae **en el momento de
guardar**, no en el link. Eso es lo que empuja a "captura + análisis automático" y no a "solo URL".

## Arquitectura

Dos puntos de entrada (Jano por Telegram, un skill para sesión interactiva de Claude Code)
comparten el mismo **formato de archivo** y la misma **carpeta de datos**, pero cada uno resuelve
la captura y el análisis con las herramientas que tiene a mano — no hay script ni proceso
compartido entre ambos.

```
Cal manda un link (Telegram o sesión interactiva)
        │
        ├─ Playwright MCP: inyectar cookies del Cookie Broker (si el dominio está whitelisteado)
        │  → navigate → take_screenshot
        │
        ├─ Analizar el screenshot
        │     Jano:     vision.ts (OpenRouter, task nuevo "design_critique")
        │     Claude Code: Read directo sobre el PNG (visión nativa, sin llamada extra)
        │
        └─ Escribir: shots/<fecha>-<slug>.png + refs/<fecha>-<slug>.md + línea en INDEX.md
```

**Por qué no hay script de captura compartido:** Jano ya tiene el MCP de Playwright allowlisteado
en su agente (`agent-options.ts` — `browser_navigate`, `browser_take_screenshot`,
`browser_run_code_unsafe`), y una sesión interactiva de Claude Code tiene el mismo MCP. No hace
falta escribir ni mantener un script nuevo de captura: ambos lados ya pueden manejar el mismo
navegador. Lo único que hay que compartir es el formato de salida.

## Carpeta de datos

```
Personal/Referencias de Diseño/
├── _FORMATO.md          ← fuente única del formato de ficha + línea de INDEX (documentado una vez)
├── INDEX.md              ← índice liviano, lo único que se carga siempre
├── refs/
│   └── 2026-07-31-linear-command-palette.md
└── shots/
    └── 2026-07-31-linear-command-palette.png
```

`_FORMATO.md` existe para que Jano (código) y el skill (instrucciones en prosa) nunca diverjan en
el formato — los dos lo referencian en vez de duplicar la plantilla.

**Ficha (`refs/<fecha>-<slug>.md`):**

```markdown
---
fuente: https://x.com/usuario/status/123
tipo: dashboard | landing | componente | paleta | tipografía | micro-interacción
tags: [dark-mode, data-density, glass]
capturado: 2026-07-31
shot: ../shots/2026-07-31-linear-command-palette.png
---

**Qué es:** paleta de comandos de Linear, densidad alta sin sentirse apretada.

**Por qué funciona:** [lo que el análisis de visión extrae — jerarquía, spacing, contraste, el
truco concreto que hace que funcione, no una descripción genérica de "qué se ve"].

**Aplicable a:** Combustible, Presupuesto Privado
```

**Línea de `INDEX.md`** (una por referencia, orden cronológico inverso):

```markdown
- [2026-07-31] **Linear — paleta de comandos** · `dashboard` · dark-mode, data-density, glass — [ficha](refs/2026-07-31-linear-command-palette.md)
```

**Slug:** del título corto que produce el análisis, normalizado (minúsculas, sin tildes, espacios
a guiones), igual que la derivación de claves de `mapaBacklogs`. Colisión el mismo día → sufijo
`-2`, `-3`.

## Captura autenticada — inyección de cookies en Playwright

El Cookie Broker (`cookie-jar.ts`) hoy solo expone `getCookieHeader()`, un string
`"a=1; b=2"` pensado para `fetchAsUser` (fetch HTTP crudo) — **no sirve para autenticar un
navegador real**. Por eso hoy, cuando Playwright choca con un login, el patrón establecido es el
handoff a Safari (skill `playwright-safari-handoff`), no resolverlo solo.

Para que la captura de X/Instagram funcione autenticada, se agrega:

1. **`cookie-jar.ts` — `getStructuredCookies(hostname, kv)`:** llama a `getCookieHeader`, parsea el
   string `"name=value; name2=value2"` y devuelve `Array<{name, value, url}>` (con
   `url: "https://" + domain`) — formato que acepta directo `context.addCookies()` de Playwright
   sin necesitar path/expiry/domain explícitos por cookie.
2. **Paso de captura (Jano y skill, mismo código conceptual):**
   ```javascript
   // browser_run_code_unsafe
   async (page) => {
     await page.context().addCookies([...cookies]);
     await page.goto(url, { waitUntil: "networkidle" });
     return await page.title();
   }
   // browser_take_screenshot
   ```
3. **Whitelist:** se agregan `x.com`, `twitter.com`, `instagram.com` a
   `~/.claude/config/cookie-jar-domains.json`. Esto es una extensión deliberada de la regla dura
   "solo medios de noticias/lectura" — **autorizada explícitamente por Cal el 2026-07-31** para
   este caso puntual. El resto de `DENY_PATTERNS` (banca, email) sigue aplicando sin cambios.

**Si no hay cookie sincronizada** (dominio whitelisteado pero sin sesión activa en Safari, o
dominio no whitelisteado): se captura igual sin cookies — puede salir un muro de login o una
tarjeta de preview pública. El análisis de visión lo nota y lo dice en el "Qué es" en vez de
inventar contenido que no vio.

## Tool nuevo en Jano — `guardarReferenciaDiseno`

`agent-tools.ts` + `system-prompt.ts`. El agente de Jano hace la orquestación (Playwright MCP +
`vision.ts`) en varios pasos con sus tools ya permitidas; esta tool nueva es solo la escritura
mecánica final:

```
guardarReferenciaDiseno({
  fuente: string,
  tituloCorto: string,
  tipo?: string,
  queEs: string,
  porQueFunciona: string,
  tags: string[],
  aplicableA?: string,
  screenshotPath: string,   // path del PNG ya capturado, en tmpdir()
})
```

- Deriva el slug, valida `screenshotPath` con `realpathSync()` + patrón fijo (mismo criterio de
  seguridad que `enviarFotoLocal`/`generateBoaWalletPass`: solo rutas bajo `tmpdir()`).
- Copia el PNG a `shots/`, escribe la ficha en `refs/`, prepende la línea en `INDEX.md`.
- Escritura atómica (temporal + `rename`), mismo patrón que `appendBacklogItem`.
- Sin tarjeta de confirmación — informativo, como `mapaBacklogs`: Jano responde con el screenshot
  + un resumen corto de lo que guardó. No hay nada que aprobar (no es una escritura sensible ni
  reversible-por-tildado como el backlog).

**`vision.ts` — nuevo `task: "design_critique"`** en `TASK_PROMPTS`: pide explícitamente jerarquía
visual, paleta, spacing, tipografía y **el patrón concreto que hace que funcione** — no una
descripción genérica de "qué se ve en la imagen" (que es lo que devuelven `describe`/`classify`
hoy).

**Disparo:** cuando Cal comparte un link con intención de guardar inspiración de diseño ("guarda
esto de diseño", "guárdame esta referencia") — no cualquier link que toque temas de diseño (un
artículo sobre UX va al resumidor, no acá). Se deja a criterio del system prompt, mismo patrón que
ya distingue resumidor/backlog/journal por el fraseo de Cal.

## Skill nuevo — `guardar-referencia-diseno`

`~/.claude/skills/guardar-referencia-diseno/SKILL.md`, para sesión interactiva de Claude Code.
Mismos pasos que Jano, pero:

- El análisis lo hace Claude directo: `Read` sobre el PNG capturado (visión nativa, sin llamar a
  ningún API externa) con el mismo prompt de crítica de diseño que `design_critique`.
- La escritura la hace Claude directo con `Write`/`Edit` — sin tool custom, siguiendo
  `_FORMATO.md` al pie de la letra.
- Mismo mecanismo de cookies (`browser_run_code_unsafe` + Cookie Broker) — el skill documenta el
  mismo snippet que usa Jano. No hay Cookie Broker "de Claude Code": es el mismo KV, mismo
  `cookie-jar-domains.json`, leído por un script chico standalone (`~/.claude/scripts/` o inline en
  el skill) que replica `getCookieHeader`/`getStructuredCookies` sin depender del código TS de
  Jano (la sesión interactiva no importa el `daemon-v2` de Jano como librería).

## Consumo — `design-style-router`

Al pedir un rediseño ("rediseña Combustible"), el router lee `INDEX.md` (liviano, siempre
disponible) y propone 2-3 referencias que apliquen antes de elegir estilo — usando el campo
`tags`/`tipo` y el nombre de la app contra `aplicableA`. Si `INDEX.md` está vacío o no hay
referencias que apliquen, el router sigue su flujo normal sin bloquear nada.

## Seguridad

- Escritura acotada a `Personal/Referencias de Diseño/` — mismo patrón de `realpathSync()` +
  verificación de que el resultado siga dentro de esa carpeta, igual que `backlog-write.ts`.
- La extensión de la whitelist del Cookie Broker a redes sociales es una excepción puntual,
  documentada acá y en el propio `cookie-jar-domains.json` (comentario actualizado) — no una
  apertura general de la regla dura.
- `browser_run_code_unsafe` es RCE-equivalent por descripción propia del tool — el código que se le
  pasa está fijo en el skill/system-prompt (inyección de cookies + `goto`), nunca generado
  libremente a partir de texto no confiable.

## Riesgos aceptados

| Riesgo | Mitigación | Estado |
|---|---|---|
| Dominio whitelisteado sin cookie sincronizada (Cal no logueado en Safari ahí) | Captura sin cookies, el análisis lo nota en vez de inventar | Aceptado |
| El análisis de visión saca conclusiones de diseño mediocres o genéricas | Prompt específico (`design_critique`) que pide el patrón concreto, no descripción | Mitigado, no verificado en producción |
| Drift entre el formato que usa Jano y el que usa el skill | `_FORMATO.md` único referenciado por ambos | Mitigado |
| El disparo por lenguaje natural confunde "guardar diseño" con "resumir artículo" | Deja a criterio del system prompt, mismo patrón que otros flujos de Jano | Aceptado |

## Fuera de alcance

- Edición o reorganización de referencias ya guardadas (renombrar, refundir, borrar).
- Sincronización con Notion o cualquier otro consumidor visual — el consumidor es Claude, no Cal
  ojeando.
- Un mecanismo genérico de "Cookie Broker para navegador" reusable por otros flujos — se construye
  acotado a este caso; si aparece otro uso, generalizar ahí.

## Verificación

- `getStructuredCookies`: parseo del header string a array de cookies, con y sin cookie
  sincronizada.
- `guardarReferenciaDiseno`: slug + colisión del mismo día, escritura atómica, `realpathSync`
  rechazando paths fuera de `tmpdir()`/fuera de la carpeta destino.
- Extremo a extremo: un link real de X (con Cal logueado en Safari) y uno de una web sin login,
  confirmando que el screenshot capturado tiene contenido real (no un muro de login) en el primer
  caso.
- Skill: correr el mismo flujo en una sesión interactiva y confirmar que la ficha resultante sigue
  `_FORMATO.md` al pie de la letra (mismo slug/frontmatter/estructura que produciría Jano).
