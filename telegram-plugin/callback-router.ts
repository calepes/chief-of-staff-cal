import { updateTaskStatus, updateTaskDate } from './notion-client';
import { play, pause, skipNext, skipPrevious, setVolume, nowPlaying } from './spotify-client';

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

function spotifyNoDeviceResult(action: string): RouteResult {
  return {
    editText: `🔇 No hay dispositivo Spotify activo.\n\nAbre Spotify en tu teléfono o compu, reproduce algo, y vuelve a intentar ${action}.`,
    toast: '🔇 Abre Spotify',
    buttons: [[
      { text: '🎵 Abrir Spotify', url: 'https://open.spotify.com' },
    ]],
  };
}

function isNoDeviceError(err?: string): boolean {
  if (!err) return false;
  const lower = err.toLowerCase();
  return lower.includes('no active device') || lower.includes('no_active_device') || lower.includes('404');
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

  // spotify:play
  if (data === 'spotify:play') {
    const r = await play()
    if (r.ok) {
      await new Promise(resolve => setTimeout(resolve, 300))
      const np = await nowPlaying()
      return { editText: `▶️ Playing: ${np.track ?? 'Unknown'} — ${np.artist ?? ''}`, toast: '▶️' }
    }
    if (isNoDeviceError(r.error)) return spotifyNoDeviceResult('play')
    return { editText: `❌ ${r.error}`, toast: 'Error' }
  }

  // spotify:pause
  if (data === 'spotify:pause') {
    const r = await pause()
    if (r.ok) return { editText: '⏸ Paused', toast: '⏸' }
    if (isNoDeviceError(r.error)) return spotifyNoDeviceResult('pause')
    return { editText: `❌ ${r.error}`, toast: 'Error' }
  }

  // spotify:skip
  if (data === 'spotify:skip') {
    const r = await skipNext()
    if (r.ok) {
      await new Promise(resolve => setTimeout(resolve, 300))
      const np = await nowPlaying()
      return { editText: `⏭ ${np.track ?? 'Unknown'} — ${np.artist ?? ''}`, toast: '⏭' }
    }
    if (isNoDeviceError(r.error)) return spotifyNoDeviceResult('skip')
    return { editText: `❌ ${r.error}`, toast: 'Error' }
  }

  // spotify:back
  if (data === 'spotify:back') {
    const r = await skipPrevious()
    if (r.ok) {
      await new Promise(resolve => setTimeout(resolve, 300))
      const np = await nowPlaying()
      return { editText: `⏮ ${np.track ?? 'Unknown'} — ${np.artist ?? ''}`, toast: '⏮' }
    }
    if (isNoDeviceError(r.error)) return spotifyNoDeviceResult('back')
    return { editText: `❌ ${r.error}`, toast: 'Error' }
  }

  // spotify:volup / spotify:voldown
  if (data === 'spotify:volup') {
    const r = await setVolume(60)
    if (r.ok) return { editText: '🔊 Volume up', toast: '🔊' }
    if (isNoDeviceError(r.error)) return spotifyNoDeviceResult('volumen')
    return { editText: `❌ ${r.error}`, toast: 'Error' }
  }
  if (data === 'spotify:voldown') {
    const r = await setVolume(40)
    if (r.ok) return { editText: '🔉 Volume down', toast: '🔉' }
    if (isNoDeviceError(r.error)) return spotifyNoDeviceResult('volumen')
    return { editText: `❌ ${r.error}`, toast: 'Error' }
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
