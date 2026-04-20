import { updateTaskStatus, updateTaskDate } from './notion-client';
import { execFileSync, spawn } from 'child_process';
import { readFileSync, existsSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface RouteButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export interface RouteResult {
  editText: string;
  toast?: string;
  buttons?: RouteButton[][];
}

const PATTERNS = {
  done:     /^t:d:([0-9a-f]{32})$/,
  cancel:   /^t:c:([0-9a-f]{32})$/,
  skip:     /^t:s:([0-9a-f]{32})$/,
  deadline: /^t:sd:([0-9a-f]{32}):dl:(\d{4}-\d{2}-\d{2})$/,
  fecha:    /^t:sd:([0-9a-f]{32}):f:(\d{4}-\d{2}-\d{2})$/,
  learnKeep:    /^learn:keep:([a-z]+-\d{4}-\d{2}-\d{2}-\d{3})$/,
  learnDrop:    /^learn:drop:([a-z]+-\d{4}-\d{2}-\d{2}-\d{3})$/,
  learnKeepAll: /^learn:keepall:([0-9a-f]{8})$/,
  learnDropAll: /^learn:dropall:([0-9a-f]{8})$/,
  buildApprove: /^build:approve:(build-\d{4}-\d{2}-\d{2}-[0-9a-f]{8})$/,
  buildReject:  /^build:reject:(build-\d{4}-\d{2}-\d{2}-[0-9a-f]{8})$/,
  skillApprove: /^skill:approve:(skill-\d{4}-W\d{2}-[a-z][a-z0-9-]+)$/,
  skillReject:  /^skill:reject:(skill-\d{4}-W\d{2}-[a-z][a-z0-9-]+)$/,
};

function runLearningsLib(fn: string, ...args: string[]): { ok: boolean; error?: string } {
  const lib = join(homedir(), '.claude/hooks/learnings-lib.sh');
  if (!existsSync(lib)) return { ok: false, error: 'learnings-lib.sh not found' };
  try {
    const script = `set -e\nsource '${lib}'\n${fn} ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`;
    execFileSync('/bin/bash', ['-c', script], { stdio: 'pipe', encoding: 'utf8' });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.stderr?.toString() || e?.message || String(e) };
  }
}

function readBatchIds(batchId: string): string[] {
  const path = join(homedir(), '.claude/state/learn-batches', batchId);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').map((s: string) => s.trim()).filter(Boolean);
}

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

  // learn:keep:<id> — flip pending:false valid:true
  m = data.match(PATTERNS.learnKeep);
  if (m) {
    const id = m[1];
    const r = runLearningsLib('flip_pending', id, 'true');
    if (!r.ok) return { editText: `❌ Error: ${r.error}`, toast: 'Error' };
    return { editText: `✅ Learning guardado: ${id}`, toast: '✅ Guardado' };
  }

  // learn:drop:<id> — archivar
  m = data.match(PATTERNS.learnDrop);
  if (m) {
    const id = m[1];
    const r = runLearningsLib('move_to_archive', id);
    if (!r.ok) return { editText: `❌ Error: ${r.error}`, toast: 'Error' };
    return { editText: `🗑 Learning descartado: ${id}`, toast: '🗑 Descartado' };
  }

  // learn:keepall:<batch_id> — flip todos los pending del batch
  m = data.match(PATTERNS.learnKeepAll);
  if (m) {
    const batchId = m[1];
    const ids = readBatchIds(batchId);
    if (ids.length === 0) return { editText: '❌ Batch no encontrado', toast: 'Error' };
    let ok = 0, fail = 0;
    for (const id of ids) {
      const r = runLearningsLib('flip_pending', id, 'true');
      if (r.ok) ok++; else fail++;
    }
    return { editText: `✅ ${ok} learnings guardados${fail > 0 ? ` (${fail} errores)` : ''}`, toast: `✅ ${ok} guardados` };
  }

  // learn:dropall:<batch_id> — archivar todos los pending del batch
  m = data.match(PATTERNS.learnDropAll);
  if (m) {
    const batchId = m[1];
    const ids = readBatchIds(batchId);
    if (ids.length === 0) return { editText: '❌ Batch no encontrado', toast: 'Error' };
    let ok = 0, fail = 0;
    for (const id of ids) {
      const r = runLearningsLib('move_to_archive', id);
      if (r.ok) ok++; else fail++;
    }
    return { editText: `🗑 ${ok} learnings descartados${fail > 0 ? ` (${fail} errores)` : ''}`, toast: `🗑 ${ok} descartados` };
  }

  // build:approve:<id> — dispara ejecutor async (no bloquea el callback)
  m = data.match(PATTERNS.buildApprove);
  if (m) {
    const id = m[1];
    const execScript = join(homedir(), '.claude/hooks/morning-build-execute.sh');
    if (!existsSync(execScript)) {
      return { editText: `❌ Executor no encontrado: ${execScript}`, toast: 'Error' };
    }
    try {
      const child = spawn('/bin/bash', [execScript, id], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { editText: `🔨 Morning-build ejecutando: ${id}\n\nTe aviso cuando termine.`, toast: '🔨 Ejecutando' };
    } catch (e: any) {
      return { editText: `❌ Error lanzando executor: ${e?.message || e}`, toast: 'Error' };
    }
  }

  // build:reject:<id> — archiva la propuesta
  m = data.match(PATTERNS.buildReject);
  if (m) {
    const id = m[1];
    const proposalFile = join(homedir(), `.claude/morning-builds/proposals/${id}.json`);
    const rejectedDir = join(homedir(), '.claude/morning-builds/rejected');
    try {
      execFileSync('/bin/mkdir', ['-p', rejectedDir]);
      if (existsSync(proposalFile)) {
        renameSync(proposalFile, join(rejectedDir, `${id}.json`));
      }
      return { editText: `🗑 Morning-build descartado: ${id}`, toast: '🗑 Descartado' };
    } catch (e: any) {
      return { editText: `❌ Error archivando: ${e?.message || e}`, toast: 'Error' };
    }
  }

  // skill:approve:<id> — dispara skill-install async
  m = data.match(PATTERNS.skillApprove);
  if (m) {
    const id = m[1];
    const installScript = join(homedir(), '.claude/hooks/skill-install.sh');
    if (!existsSync(installScript)) {
      return { editText: `❌ Installer no encontrado: ${installScript}`, toast: 'Error' };
    }
    try {
      const child = spawn('/bin/bash', [installScript, id], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { editText: `🔨 Instalando skill: ${id}\n\nTe aviso cuando termine.`, toast: '🔨 Instalando' };
    } catch (e: any) {
      return { editText: `❌ Error lanzando installer: ${e?.message || e}`, toast: 'Error' };
    }
  }

  // skill:reject:<id> — archiva la propuesta
  m = data.match(PATTERNS.skillReject);
  if (m) {
    const id = m[1];
    const proposalFile = join(homedir(), `.claude/skill-proposals/${id}.json`);
    const rejectedDir = join(homedir(), '.claude/skill-proposals/rejected');
    try {
      execFileSync('/bin/mkdir', ['-p', rejectedDir]);
      if (existsSync(proposalFile)) {
        renameSync(proposalFile, join(rejectedDir, `${id}.json`));
      }
      return { editText: `🗑 Skill descartado: ${id}`, toast: '🗑 Descartado' };
    } catch (e: any) {
      return { editText: `❌ Error archivando: ${e?.message || e}`, toast: 'Error' };
    }
  }

  // approve:yes / approve:no — aprobaciones rápidas (router mecánico)
  if (data.startsWith('approve:yes') || data.startsWith('approve:no')) {
    const isYes = data.startsWith('approve:yes')
    const context = data.split(':').slice(2).join(':') || ''
    const label = isYes ? '✅ Aprobado' : '❌ Rechazado'
    const suffix = context ? ` — ${context}` : ''
    return {
      editText: `${label}${suffix}`,
      toast: label,
    }
  }

  return null;
}
