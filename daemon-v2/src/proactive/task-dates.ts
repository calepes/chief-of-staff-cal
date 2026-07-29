// task-dates.ts — atajos de fecha de la tarjeta de tareas y parser del texto libre ("✍️ Escribir").
// Módulo PURO: nada de red, nada de reloj propio — el "hoy" entra siempre por parámetro (ISO
// yyyy-mm-dd calculado con nowInLaPaz() por el caller). Nunca usar `new Date()` acá: derivar una
// fecha de calendario en UTC adelanta un día entre las 20:00 y medianoche hora de Cal (gotcha
// documentado en CLAUDE.md).

export type DateShortcut = "hoy" | "vie" | "prox" | "no";

const DIAS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];

/** Fecha ISO → partes numéricas, sin pasar por Date (evita cualquier corrimiento de zona). */
function parseIso(iso: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** Aritmética de calendario en UTC puro: se entra con una fecha ISO "desnuda" (sin hora ni zona)
 * y se sale igual, así que el UTC de acá adentro es un detalle de implementación, no una zona. */
function isoToUtc(iso: string): Date | null {
  const p = parseIso(iso);
  if (!p) return null;
  return new Date(Date.UTC(p.y, p.m - 1, p.d));
}

function utcToIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = isoToUtc(iso);
  if (!d) throw new Error(`fecha ISO inválida: ${iso}`);
  d.setUTCDate(d.getUTCDate() + days);
  return utcToIso(d);
}

/** 0=domingo … 6=sábado, igual que Date.getDay(). */
export function dayOfWeek(iso: string): number {
  const d = isoToUtc(iso);
  if (!d) throw new Error(`fecha ISO inválida: ${iso}`);
  return d.getUTCDay();
}

/**
 * Próxima ocurrencia de un día de la semana, contando HOY como válido.
 * Un sábado, "viernes" cae recién en 6 días — a propósito: un atajo nunca debe proponer una
 * fecha ya pasada.
 */
export function nextWeekday(todayIso: string, target: number): string {
  const delta = (target - dayOfWeek(todayIso) + 7) % 7;
  return addDays(todayIso, delta);
}

/** Viernes de "esta semana" — o el próximo viernes si hoy ya es fin de semana. */
export function fridayThisWeek(todayIso: string): string {
  return nextWeekday(todayIso, 5);
}

export function fridayNextWeek(todayIso: string): string {
  return addDays(fridayThisWeek(todayIso), 7);
}

/** Resuelve el atajo de un botón a una fecha ISO. "no" = limpiar la propiedad. */
export function resolveShortcut(kind: DateShortcut, todayIso: string): string | null {
  switch (kind) {
    case "hoy":
      return todayIso;
    case "vie":
      return fridayThisWeek(todayIso);
    case "prox":
      return fridayNextWeek(todayIso);
    case "no":
      return null;
  }
}

/** dd/mm para los labels de los botones — la card muestra la fecha real, no solo "Esta semana". */
export function shortLabel(iso: string): string {
  const p = parseIso(iso);
  if (!p) return iso;
  return `${String(p.d).padStart(2, "0")}/${String(p.m).padStart(2, "0")}`;
}

export interface ParsedDate {
  /** null = "sin fecha" explícito (Cal escribió "ninguna"/"sin fecha"), no "no entendí". */
  date: string | null;
}

/**
 * Parser del texto libre del botón "✍️ Escribir".
 *
 * Devuelve null cuando NO reconoce una fecha. Esa distinción es la que protege el chat: el
 * interceptor de index.ts solo consume el mensaje si acá sale algo, y si no, lo deja pasar al
 * LLM como un pedido normal. Sin eso, el estado "esperando fecha" se tragaría un mensaje real de
 * Cal — exactamente el gotcha que ya pasó con el modo journal.
 */
export function parseWrittenDate(text: string, todayIso: string): ParsedDate | null {
  const t = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  if (!t) return null;

  if (/^(sin fecha|ninguna|ninguno|nada|quitar|limpiar|borrar)$/.test(t)) return { date: null };
  if (/^hoy$/.test(t)) return { date: todayIso };
  if (/^manana$/.test(t)) return { date: addDays(todayIso, 1) };
  if (/^pasado manana$/.test(t)) return { date: addDays(todayIso, 2) };

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return isValidCalendarDate(t) ? { date: t } : null;

  // dd/mm o dd/mm/yyyy (también con guiones). Sin año → el año en curso, salvo que la fecha ya
  // haya pasado: ahí se asume el año siguiente ("2/1" escrito un 28 de diciembre es enero).
  const dm = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/.exec(t);
  if (dm) {
    const d = Number(dm[1]);
    const mes = Number(dm[2]);
    const hoy = parseIso(todayIso)!;
    let y = hoy.y;
    if (dm[3]) {
      const raw = Number(dm[3]);
      y = raw < 100 ? 2000 + raw : raw;
    }
    const cand = `${y}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (!isValidCalendarDate(cand)) return null;
    if (!dm[3] && cand < todayIso) {
      const next = `${y + 1}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      return isValidCalendarDate(next) ? { date: next } : null;
    }
    return { date: cand };
  }

  // "viernes", "el viernes", "proximo viernes"
  const dia = /^(?:el |este |proximo |la |del )*([a-z]+)$/.exec(t);
  if (dia) {
    const idx = DIAS.indexOf(dia[1]!);
    if (idx >= 0) {
      const base = nextWeekday(todayIso, idx);
      return { date: /proximo/.test(t) ? addDays(base, 7) : base };
    }
  }

  return null;
}

/** Rechaza 31/02 y compañía: construir la fecha y verificar que no rebotó a otro día. */
function isValidCalendarDate(iso: string): boolean {
  const p = parseIso(iso);
  if (!p) return false;
  if (p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31) return false;
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  return d.getUTCFullYear() === p.y && d.getUTCMonth() === p.m - 1 && d.getUTCDate() === p.d;
}
