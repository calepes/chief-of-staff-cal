import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Corre una expresión `jq` sobre un archivo de persisted-output del SDK.
 *
 * Por qué existe: cuando un tool result supera ~25 KB, el SDK lo escribe a disco y le pasa al
 * modelo solo un path. `readPersistedOutput` trae el archivo ENTERO de vuelta al contexto, lo
 * que para un dump de Notion de 350 KB es exactamente el problema que el persisted-output
 * quería evitar — y en la práctica lleva al modelo a quemar turnos reintentando.
 *
 * Esto le da la capacidad que tengo yo en una sesión interactiva: filtrar el archivo con `jq`
 * y traerme solo el pedazo que necesito, sin que el resto toque el contexto. Es lo que faltaba
 * el 2026-07-27 cuando Cal pidió "toma los valores de los sábados" sobre la DB de KPIs.
 *
 * NO es un `Bash` general: `Bash` está en DISALLOWED_BUILTINS y sigue estándolo. Acá se
 * ejecuta un único binario conocido, sin shell, sobre un path de una allowlist.
 */

// Misma allowlist que read-persisted.ts: solo tool-results del cache de proyectos del SDK.
const ALLOWED_RE = new RegExp(
  `^${homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.claude/projects/[^/]+/[^/]+/tool-results/toolu_[A-Za-z0-9]+\\.json$`,
);

const JQ_BIN = "/usr/bin/jq";
const TIMEOUT_MS = 10_000;
/** Tope de salida. Por encima de esto volveríamos a caer en el persisted-output loop que este tool evita. */
const MAX_OUTPUT_CHARS = 20_000;

export interface ConsultarJsonResult {
  ok: boolean;
  text?: string;
  error?: string;
  truncated?: boolean;
}

export async function consultarJson(path: string, jqExpr: string): Promise<ConsultarJsonResult> {
  // Resolver ANTES de validar. El regex acepta `..` en sus segmentos `[^/]+`, así que
  // `~/.claude/projects/../../tool-results/toolu_x.json` pasaba el chequeo y apuntaba a
  // `~/tool-results/toolu_x.json` — fuera del árbol permitido. `realpathSync` colapsa el `..` y
  // además sigue symlinks, cerrando las dos variantes de una. Es el mismo patrón que ya usa
  // `tools/telegram-files.ts`. Encontrado por daemon-health-reviewer (debilidad heredada de
  // `read-persisted.ts`, que tiene el regex idéntico y sigue teniéndola).
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch {
    return { ok: false, error: "No pude resolver el path (¿existe el archivo?)." };
  }

  if (!ALLOWED_RE.test(resolved)) {
    return { ok: false, error: "Path no permitido. Solo archivos tool-results en ~/.claude/projects." };
  }

  let payload: string;
  try {
    const raw = readFileSync(resolved, "utf8");
    // El persisted-output es un array de content blocks; el JSON que interesa vive dentro del
    // `.text` de esos bloques, no en el envoltorio. Correr jq sobre el archivo crudo devolvería
    // la estructura del envoltorio y ninguno de los datos que Cal pidió.
    try {
      const blocks = JSON.parse(raw) as Array<{ type: string; text?: string }>;
      const joined = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n");
      payload = joined || raw;
    } catch {
      payload = raw;
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // execFile ASÍNCRONO, no spawnSync. spawnSync congela el proceso entero mientras corre — y
  // este daemon es un solo proceso: se frenarían el poll loop de Telegram (todos los chats), los
  // `editMessage` de progreso del turno en curso, el webhook watchdog de 1 min y los 4 crons
  // proactivos. Hasta 10s de parálisis global por una consulta. Es el mismo motivo por el que
  // `captureThought`/`resu-pick:` se hicieron fire-and-forget; acá no se puede porque el tool
  // tiene que devolver un valor, así que la salida es await. Señalado por daemon-health-reviewer.
  let stdout: string;
  try {
    // A diferencia de spawnSync, execFile no acepta `input`: el payload se escribe al stdin del
    // hijo, que `promisify(execFile)` expone en `.child`.
    const pending = execFileAsync(JQ_BIN, ["--", jqExpr], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      // Entorno DELIBERADAMENTE vacío salvo PATH. jq expone el entorno del proceso vía `env` y
      // `$ENV` (verificado: `FOO=secreto jq -n 'env.FOO'` devuelve "secreto"), y este daemon corre
      // con NOTION_TOKEN, COS_TELEGRAM_BOT_TOKEN y todo apps.env cargado. Sin esto, una expresión
      // con `env` — escrita por error por el modelo, o inducida por prompt injection en contenido
      // web que Jano haya leído — volcaría todos los secretos de Cal al contexto y de ahí a Telegram.
      env: { PATH: "/usr/bin:/bin" },
      // Sin esto Node corta en 1 MB y devuelve ENOBUFS. Una expresión amplia sobre un dump de
      // Notion supera ese techo fácil, y el modelo recibiría un error críptico en vez de la salida
      // truncada que este tool promete. El truncado real lo hace MAX_OUTPUT_CHARS, que es explícito.
      maxBuffer: 64 * 1024 * 1024,
    });
    // `.catch()` en el write: si jq muere temprano (expresión inválida), el stdin se cierra y el
    // write emite EPIPE. El error real lo reporta el await de abajo; un EPIPE sin manejar acá
    // sería un unhandled rejection que puede tumbar el proceso.
    pending.child.stdin?.on("error", () => {});
    pending.child.stdin?.end(payload);
    const res = await pending;
    stdout = res.stdout;
  } catch (e) {
    // `--` antes de la expresión: sin eso, un jqExpr que empiece con `-` lo parsea jq como flag.
    const err = e as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; code?: string | number };
    if (err.killed || err.code === "ETIMEDOUT") {
      return { ok: false, error: `La consulta jq tardó más de ${TIMEOUT_MS / 1000}s y se canceló. Acotá la expresión.` };
    }
    if (err.code === "ENOBUFS") {
      return { ok: false, error: "La salida de jq fue enorme. Acotá la expresión (filtrá campos o usá `length`)." };
    }
    if (err.stderr) {
      return { ok: false, error: `jq falló: ${err.stderr.trim().slice(0, 500)}` };
    }
    return { ok: false, error: err.message };
  }

  const out = stdout ?? "";
  if (out.length > MAX_OUTPUT_CHARS) {
    return {
      ok: true,
      truncated: true,
      text: out.slice(0, MAX_OUTPUT_CHARS),
    };
  }

  return { ok: true, text: out };
}
