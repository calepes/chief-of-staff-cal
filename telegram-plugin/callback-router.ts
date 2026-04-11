import { updateTaskStatus, updateTaskDate } from './notion-client';

export interface RouteResult {
  editText: string;
  toast?: string;
}

const PATTERNS = {
  done:     /^t:d:([0-9a-f]{32})$/,
  cancel:   /^t:c:([0-9a-f]{32})$/,
  skip:     /^t:s:([0-9a-f]{32})$/,
  deadline: /^t:sd:([0-9a-f]{32}):dl:(\d{4}-\d{2}-\d{2})$/,
  fecha:    /^t:sd:([0-9a-f]{32}):f:(\d{4}-\d{2}-\d{2})$/,
};

export async function routeCallback(data: string): Promise<RouteResult | null> {
  let m: RegExpMatchArray | null;

  m = data.match(PATTERNS.done);
  if (m) {
    const result = await updateTaskStatus(m[1], 'Listo');
    if (!result.ok) return { editText: `❌ Error: ${result.error}`, toast: 'Error' };
    return { editText: '✅ Tarea marcada como Listo', toast: '✅ Listo' };
  }

  m = data.match(PATTERNS.cancel);
  if (m) {
    const result = await updateTaskStatus(m[1], 'Cancelada');
    if (!result.ok) return { editText: `❌ Error: ${result.error}`, toast: 'Error' };
    return { editText: '❌ Tarea cancelada', toast: '❌ Cancelada' };
  }

  m = data.match(PATTERNS.skip);
  if (m) {
    return { editText: '⏭ Tarea sin cambios', toast: '⏭' };
  }

  m = data.match(PATTERNS.deadline);
  if (m) {
    const [, id, date] = m;
    const result = await updateTaskDate(id, 'Deadline', date);
    if (!result.ok) return { editText: `❌ Error: ${result.error}`, toast: 'Error' };
    return { editText: `📅 Deadline actualizado: ${date}`, toast: '📅 Actualizado' };
  }

  m = data.match(PATTERNS.fecha);
  if (m) {
    const [, id, date] = m;
    const result = await updateTaskDate(id, 'Fecha', date);
    if (!result.ok) return { editText: `❌ Error: ${result.error}`, toast: 'Error' };
    return { editText: `📅 Fecha actualizada: ${date}`, toast: '📅 Actualizado' };
  }

  return null;
}
