export function getAppHtml(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>Spotify</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #2d1b69 100%);
      color: #fff;
      overflow: hidden;
      height: 100vh;
      height: 100dvh;
      position: relative;
    }

    #bg-gradient {
      position: fixed;
      inset: 0;
      background: linear-gradient(135deg, #1a1a2e 0%, #2d1b69 100%);
      transition: background 1.2s ease;
      z-index: 0;
    }

    #bg-blur {
      position: fixed;
      inset: 0;
      backdrop-filter: blur(60px);
      -webkit-backdrop-filter: blur(60px);
      z-index: 1;
    }

    #player {
      position: relative;
      z-index: 2;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-evenly;
      height: 100vh;
      height: 100dvh;
      padding: 16px 24px 24px;
      max-width: 480px;
      margin: 0 auto;
    }

    /* Album art */
    .art-container {
      width: min(280px, 65vw);
      height: min(280px, 65vw);
      border-radius: 16px;
      background: rgba(255,255,255,0.08);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      box-shadow: 0 24px 64px rgba(0,0,0,0.5), 0 4px 16px rgba(0,0,0,0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      flex-shrink: 0;
    }

    .art-container img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 16px;
    }

    .art-placeholder {
      font-size: 80px;
      line-height: 1;
      user-select: none;
    }

    /* Track info */
    .track-info {
      width: 100%;
      text-align: center;
      padding: 0 8px;
    }

    .track-name {
      font-size: 18px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 4px;
    }

    .track-artist {
      font-size: 14px;
      color: rgba(255,255,255,0.65);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 2px;
    }

    .track-album {
      font-size: 12px;
      color: rgba(255,255,255,0.4);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Progress */
    .progress-section {
      width: 100%;
    }

    .progress-bar-bg {
      width: 100%;
      height: 4px;
      background: rgba(255,255,255,0.2);
      border-radius: 2px;
      cursor: pointer;
      transition: height 0.15s ease;
      position: relative;
    }

    .progress-bar-bg:hover {
      height: 6px;
    }

    .progress-bar-fill {
      height: 100%;
      border-radius: 2px;
      background: linear-gradient(90deg, #1DB954, #1ed760);
      transition: width 0.1s linear;
      pointer-events: none;
    }

    .progress-times {
      display: flex;
      justify-content: space-between;
      margin-top: 6px;
      font-size: 11px;
      color: rgba(255,255,255,0.5);
    }

    /* Controls */
    .controls {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      width: 100%;
    }

    .ctrl-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: rgba(255,255,255,0.1);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border-radius: 50%;
      color: #fff;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.1s ease;
      flex-shrink: 0;
    }

    .ctrl-btn:active {
      transform: scale(0.92);
    }

    .ctrl-btn.sm {
      width: 40px;
      height: 40px;
      font-size: 16px;
    }

    .ctrl-btn.md {
      width: 44px;
      height: 44px;
      font-size: 20px;
    }

    .ctrl-btn.lg {
      width: 56px;
      height: 56px;
      font-size: 26px;
      background: rgba(255,255,255,0.15);
    }

    .ctrl-btn.active {
      color: #1DB954;
    }

    .ctrl-btn:hover {
      background: rgba(255,255,255,0.2);
    }

    /* Volume */
    .volume-section {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
    }

    .vol-icon {
      font-size: 16px;
      color: rgba(255,255,255,0.5);
      flex-shrink: 0;
    }

    input[type=range] {
      -webkit-appearance: none;
      appearance: none;
      flex: 1;
      height: 4px;
      background: rgba(255,255,255,0.2);
      border-radius: 2px;
      outline: none;
      cursor: pointer;
    }

    input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #fff;
      cursor: pointer;
      box-shadow: 0 0 4px rgba(0,0,0,0.3);
    }

    input[type=range]::-moz-range-thumb {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #fff;
      cursor: pointer;
      border: none;
    }

    /* Nav bar */
    .nav-bar {
      display: flex;
      gap: 12px;
      width: 100%;
    }

    .nav-btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 12px;
      border: none;
      background: rgba(255,255,255,0.1);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border-radius: 16px;
      color: #fff;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .nav-btn:hover {
      background: rgba(255,255,255,0.18);
    }

    .nav-btn:active {
      background: rgba(255,255,255,0.25);
    }

    /* Sheet overlays */
    .sheet-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 10;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s ease;
    }

    .sheet-overlay.open {
      opacity: 1;
      pointer-events: all;
    }

    .sheet {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      height: 85vh;
      background: rgba(20, 14, 50, 0.85);
      backdrop-filter: blur(40px);
      -webkit-backdrop-filter: blur(40px);
      border-radius: 20px 20px 0 0;
      z-index: 11;
      transform: translateY(100%);
      transition: transform 0.35s cubic-bezier(0.32, 0.72, 0, 1);
      display: flex;
      flex-direction: column;
    }

    .sheet.open {
      transform: translateY(0);
    }

    .sheet-handle {
      width: 36px;
      height: 4px;
      background: rgba(255,255,255,0.3);
      border-radius: 2px;
      margin: 12px auto 0;
      flex-shrink: 0;
    }

    .sheet-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px 12px;
      flex-shrink: 0;
    }

    .sheet-title {
      font-size: 17px;
      font-weight: 700;
    }

    .sheet-close {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      border: none;
      background: rgba(255,255,255,0.15);
      color: #fff;
      font-size: 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .sheet-body {
      flex: 1;
      overflow-y: auto;
      padding: 0 16px 24px;
    }

    .sheet-body::-webkit-scrollbar { display: none; }

    /* Search */
    .search-input-wrapper {
      position: relative;
      margin-bottom: 16px;
    }

    .search-input-wrapper::before {
      content: '🔍';
      position: absolute;
      left: 12px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 14px;
      pointer-events: none;
    }

    .search-input {
      width: 100%;
      padding: 12px 16px 12px 38px;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 12px;
      color: #fff;
      font-size: 15px;
      outline: none;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }

    .search-input::placeholder {
      color: rgba(255,255,255,0.4);
    }

    .search-input:focus {
      border-color: rgba(29,185,84,0.5);
    }

    /* Results */
    .results-section {
      margin-bottom: 16px;
    }

    .results-section-title {
      font-size: 13px;
      font-weight: 600;
      color: rgba(255,255,255,0.5);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }

    .result-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 8px;
      border-radius: 10px;
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .result-item:hover, .result-item:active {
      background: rgba(255,255,255,0.1);
    }

    .result-item.now-playing {
      background: rgba(29,185,84,0.15);
    }

    .result-img {
      width: 44px;
      height: 44px;
      border-radius: 6px;
      object-fit: cover;
      flex-shrink: 0;
      background: rgba(255,255,255,0.1);
    }

    .result-img.round {
      border-radius: 50%;
    }

    .result-text {
      flex: 1;
      min-width: 0;
    }

    .result-name {
      font-size: 14px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .result-sub {
      font-size: 12px;
      color: rgba(255,255,255,0.5);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 2px;
    }

    .result-item.now-playing .result-name {
      color: #1DB954;
    }

    /* Queue */
    .queue-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 8px;
      border-radius: 10px;
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .queue-item:hover {
      background: rgba(255,255,255,0.08);
    }

    .queue-item.current {
      background: rgba(29,185,84,0.15);
    }

    .queue-item.current .queue-name {
      color: #1DB954;
    }

    .queue-img {
      width: 44px;
      height: 44px;
      border-radius: 6px;
      object-fit: cover;
      flex-shrink: 0;
      background: rgba(255,255,255,0.1);
    }

    .queue-text { flex: 1; min-width: 0; }

    .queue-name {
      font-size: 14px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .queue-sub {
      font-size: 12px;
      color: rgba(255,255,255,0.5);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 2px;
    }

    .queue-section-label {
      font-size: 12px;
      font-weight: 700;
      color: rgba(255,255,255,0.35);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 12px 8px 6px;
    }

    /* Skeleton */
    .skeleton {
      background: rgba(255,255,255,0.08);
      border-radius: 6px;
      position: relative;
      overflow: hidden;
    }

    .skeleton::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.08) 50%, transparent 100%);
      animation: shimmer 1.4s infinite;
    }

    @keyframes shimmer {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }

    .skeleton-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 8px;
    }

    .skeleton-img {
      width: 44px;
      height: 44px;
      border-radius: 6px;
      flex-shrink: 0;
    }

    .skeleton-text { flex: 1; }
    .skeleton-line-a { height: 14px; border-radius: 4px; margin-bottom: 6px; width: 70%; }
    .skeleton-line-b { height: 12px; border-radius: 4px; width: 45%; }

    /* Empty state */
    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
      color: rgba(255,255,255,0.35);
      font-size: 14px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div id="bg-gradient"></div>
  <div id="bg-blur"></div>

  <div id="player">
    <!-- Album art -->
    <div class="art-container" id="art-container">
      <img id="art-img" src="" alt="" style="display:none;" />
      <div class="art-placeholder" id="art-placeholder">🎵</div>
    </div>

    <!-- Track info -->
    <div class="track-info">
      <div class="track-name" id="track-name">No hay nada sonando</div>
      <div class="track-artist" id="track-artist">—</div>
      <div class="track-album" id="track-album"></div>
    </div>

    <!-- Progress bar -->
    <div class="progress-section">
      <div class="progress-bar-bg" id="progress-bg" onclick="seekTo(event)">
        <div class="progress-bar-fill" id="progress-fill" style="width:0%"></div>
      </div>
      <div class="progress-times">
        <span id="time-current">0:00</span>
        <span id="time-total">0:00</span>
      </div>
    </div>

    <!-- Controls -->
    <div class="controls">
      <button class="ctrl-btn sm" id="btn-shuffle" onclick="toggleShuffle()" title="Shuffle">⇄</button>
      <button class="ctrl-btn md" onclick="api(\\'POST\\', \\'/api/previous\\')" title="Anterior">⏮</button>
      <button class="ctrl-btn lg" id="btn-play" onclick="togglePlay()" title="Play/Pause">▶</button>
      <button class="ctrl-btn md" onclick="api(\\'POST\\', \\'/api/next\\')" title="Siguiente">⏭</button>
      <button class="ctrl-btn sm" id="btn-repeat" onclick="toggleRepeat()" title="Repeat">↺</button>
    </div>

    <!-- Volume -->
    <div class="volume-section">
      <span class="vol-icon">🔈</span>
      <input type="range" id="volume-slider" min="0" max="100" value="50"
             oninput="setVolume(this.value)" />
      <span class="vol-icon">🔊</span>
    </div>

    <!-- Nav bar -->
    <div class="nav-bar">
      <button class="nav-btn" onclick="openSheet(\\'search\\')">🔍 Buscar</button>
      <button class="nav-btn" onclick="openSheet(\\'queue\\')">📋 Cola</button>
    </div>
  </div>

  <!-- Search sheet -->
  <div class="sheet-overlay" id="overlay-search" onclick="closeSheet(\\'search\\')"></div>
  <div class="sheet" id="sheet-search">
    <div class="sheet-handle"></div>
    <div class="sheet-header">
      <span class="sheet-title">Buscar</span>
      <button class="sheet-close" onclick="closeSheet(\\'search\\')">✕</button>
    </div>
    <div class="sheet-body">
      <div class="search-input-wrapper">
        <input class="search-input" id="search-input" type="text" placeholder="Artistas, canciones, playlists..."
               oninput="debounceSearch(this.value)" />
      </div>
      <div id="search-results"></div>
    </div>
  </div>

  <!-- Queue sheet -->
  <div class="sheet-overlay" id="overlay-queue" onclick="closeSheet(\\'queue\\')"></div>
  <div class="sheet" id="sheet-queue">
    <div class="sheet-handle"></div>
    <div class="sheet-header">
      <span class="sheet-title">Cola de reproducción</span>
      <button class="sheet-close" onclick="closeSheet(\\'queue\\')">✕</button>
    </div>
    <div class="sheet-body">
      <div id="queue-list"></div>
    </div>
  </div>

  <script>
    // ── State ──────────────────────────────────────────────────────────────
    let currentTrackId = null;
    let isPlaying = false;
    let progressMs = 0;
    let durationMs = 0;
    let lastPollTime = 0;
    let pollInterval = 5000;
    let pollTimer = null;
    let rafId = null;
    let volumeTimer = null;
    let searchTimer = null;

    // ── Init ───────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
      if (window.Telegram && Telegram.WebApp) {
        Telegram.WebApp.expand();
        Telegram.WebApp.BackButton.onClick(() => {
          if (document.querySelector('.sheet.open')) {
            closeAllSheets();
          }
        });
      }
      startPoll();
      startProgressAnimation();
    });

    // ── API helper ─────────────────────────────────────────────────────────
    async function api(method, path, body) {
      try {
        const opts = { method, headers: { 'Content-Type': 'application/json' } };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(path, opts);
        if (res.status === 204) return null;
        const text = await res.text();
        if (!text) return null;
        try { return JSON.parse(text); } catch { return null; }
      } catch (e) {
        console.error('API error:', e);
        return null;
      }
    }

    // ── Polling ────────────────────────────────────────────────────────────
    function startPoll() {
      poll();
      pollTimer = setInterval(poll, pollInterval);
    }

    function resetPoll() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(poll, pollInterval);
    }

    async function poll() {
      const data = await api('GET', '/api/now-playing');
      lastPollTime = Date.now();
      if (data && data.item) {
        updatePlayer(data);
      } else {
        showNoPlayback();
      }
    }

    // ── Player update ──────────────────────────────────────────────────────
    function updatePlayer(data) {
      const track = data.item;
      const newId = track.id;

      progressMs = data.progress_ms || 0;
      durationMs = track.duration_ms || 0;
      isPlaying = data.is_playing;

      document.getElementById('track-name').textContent = track.name || '—';
      document.getElementById('track-artist').textContent =
        track.artists ? track.artists.map(a => a.name).join(', ') : '—';
      document.getElementById('track-album').textContent =
        track.album ? track.album.name : '';

      updateProgress();
      document.getElementById('btn-play').textContent = isPlaying ? '⏸' : '▶';

      if (newId !== currentTrackId) {
        currentTrackId = newId;
        const imgUrl = track.album && track.album.images && track.album.images[0]
          ? track.album.images[0].url : null;
        if (imgUrl) {
          const img = document.getElementById('art-img');
          img.onload = () => {
            document.getElementById('art-placeholder').style.display = 'none';
            img.style.display = 'block';
            extractColors(img);
          };
          img.onerror = () => {
            img.style.display = 'none';
            document.getElementById('art-placeholder').style.display = 'flex';
            resetBackground();
          };
          img.src = imgUrl;
        } else {
          document.getElementById('art-img').style.display = 'none';
          document.getElementById('art-placeholder').style.display = 'flex';
          resetBackground();
        }
      }
    }

    function showNoPlayback() {
      document.getElementById('track-name').textContent = 'No hay nada sonando';
      document.getElementById('track-artist').textContent = '—';
      document.getElementById('track-album').textContent = '';
      document.getElementById('btn-play').textContent = '▶';
      document.getElementById('progress-fill').style.width = '0%';
      document.getElementById('time-current').textContent = '0:00';
      document.getElementById('time-total').textContent = '0:00';
      isPlaying = false;
      currentTrackId = null;
      progressMs = 0;
      durationMs = 0;
    }

    // ── Progress ───────────────────────────────────────────────────────────
    function updateProgress() {
      if (!durationMs) return;
      const pct = Math.min(100, (progressMs / durationMs) * 100);
      document.getElementById('progress-fill').style.width = pct + '%';
      document.getElementById('time-current').textContent = formatMs(progressMs);
      document.getElementById('time-total').textContent = formatMs(durationMs);
    }

    function startProgressAnimation() {
      let lastTs = null;
      function frame(ts) {
        if (isPlaying && durationMs > 0) {
          if (lastTs !== null) {
            progressMs = Math.min(durationMs, progressMs + (ts - lastTs));
            updateProgress();
          }
        }
        lastTs = ts;
        rafId = requestAnimationFrame(frame);
      }
      rafId = requestAnimationFrame(frame);
    }

    function formatMs(ms) {
      const totalSec = Math.floor(ms / 1000);
      const min = Math.floor(totalSec / 60);
      const sec = totalSec % 60;
      return min + ':' + String(sec).padStart(2, '0');
    }

    // ── Controls ───────────────────────────────────────────────────────────
    async function togglePlay() {
      const endpoint = isPlaying ? '/api/pause' : '/api/play';
      isPlaying = !isPlaying;
      document.getElementById('btn-play').textContent = isPlaying ? '⏸' : '▶';
      await api('PUT', endpoint);
      resetPoll();
    }

    function toggleShuffle() {
      const btn = document.getElementById('btn-shuffle');
      btn.classList.toggle('active');
    }

    function toggleRepeat() {
      const btn = document.getElementById('btn-repeat');
      btn.classList.toggle('active');
    }

    function setVolume(val) {
      if (volumeTimer) clearTimeout(volumeTimer);
      volumeTimer = setTimeout(async () => {
        await api('PUT', '/api/volume?percent=' + encodeURIComponent(val));
      }, 300);
    }

    function seekTo(e) {
      const bg = document.getElementById('progress-bg');
      const rect = bg.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      progressMs = Math.floor(pct * durationMs);
      updateProgress();
      api('PUT', '/api/seek?position_ms=' + Math.floor(progressMs));
      resetPoll();
    }

    // ── Dynamic background ─────────────────────────────────────────────────
    function extractColors(img) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 4;
        canvas.height = 4;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 4, 4);
        const d = ctx.getImageData(0, 0, 4, 4).data;
        // sample corners: top-left(0), top-right(3), bottom-left(12), bottom-right(15)
        const corners = [0, 3, 12, 15].map(i => {
          const base = i * 4;
          return [d[base], d[base+1], d[base+2]];
        });
        // darken for background
        const c0 = corners[0].map(v => Math.floor(v * 0.4));
        const c1 = corners[3].map(v => Math.floor(v * 0.5));
        const grad = \`linear-gradient(135deg, rgb(\${c0.join(',')}) 0%, rgb(\${c1.join(',')}) 100%)\`;
        document.getElementById('bg-gradient').style.background = grad;
      } catch(e) {
        resetBackground();
      }
    }

    function resetBackground() {
      document.getElementById('bg-gradient').style.background =
        'linear-gradient(135deg, #1a1a2e 0%, #2d1b69 100%)';
    }

    // ── Sheets ─────────────────────────────────────────────────────────────
    function openSheet(name) {
      document.getElementById('overlay-' + name).classList.add('open');
      document.getElementById('sheet-' + name).classList.add('open');
      if (window.Telegram && Telegram.WebApp && Telegram.WebApp.BackButton) {
        Telegram.WebApp.BackButton.show();
      }
      if (name === 'queue') loadQueue();
    }

    function closeSheet(name) {
      document.getElementById('overlay-' + name).classList.remove('open');
      document.getElementById('sheet-' + name).classList.remove('open');
      if (!document.querySelector('.sheet.open')) {
        if (window.Telegram && Telegram.WebApp && Telegram.WebApp.BackButton) {
          Telegram.WebApp.BackButton.hide();
        }
      }
      if (name === 'search') {
        document.getElementById('search-input').value = '';
        document.getElementById('search-results').innerHTML = '';
      }
    }

    function closeAllSheets() {
      ['search', 'queue'].forEach(n => {
        document.getElementById('overlay-' + n).classList.remove('open');
        document.getElementById('sheet-' + n).classList.remove('open');
      });
      document.getElementById('search-input').value = '';
      document.getElementById('search-results').innerHTML = '';
      if (window.Telegram && Telegram.WebApp && Telegram.WebApp.BackButton) {
        Telegram.WebApp.BackButton.hide();
      }
    }

    // ── Search ─────────────────────────────────────────────────────────────
    function debounceSearch(q) {
      if (searchTimer) clearTimeout(searchTimer);
      if (!q.trim()) {
        document.getElementById('search-results').innerHTML = '';
        return;
      }
      searchTimer = setTimeout(() => doSearch(q.trim()), 400);
    }

    async function doSearch(q) {
      const container = document.getElementById('search-results');
      container.innerHTML = renderSkeletons(5);
      const data = await api('GET', '/api/search?q=' + encodeURIComponent(q));
      if (!data) {
        container.innerHTML = '<div class="empty-state">Sin resultados</div>';
        return;
      }
      let html = '';
      if (data.tracks && data.tracks.items && data.tracks.items.length) {
        html += '<div class="results-section"><div class="results-section-title">Canciones</div>';
        data.tracks.items.forEach(t => {
          const img = t.album && t.album.images && t.album.images[0]
            ? esc(t.album.images[0].url) : '';
          const artist = t.artists ? t.artists.map(a => a.name).join(', ') : '';
          const active = t.id === currentTrackId ? ' now-playing' : '';
          html += \`<div class="result-item\${active}" onclick="playUri('\${esc(t.uri)}')">
            \${img ? \`<img class="result-img" src="\${img}" alt="" />\` : '<div class="result-img skeleton"></div>'}
            <div class="result-text">
              <div class="result-name">\${esc(t.name)}</div>
              <div class="result-sub">\${esc(artist)}</div>
            </div>
          </div>\`;
        });
        html += '</div>';
      }
      if (data.artists && data.artists.items && data.artists.items.length) {
        html += '<div class="results-section"><div class="results-section-title">Artistas</div>';
        data.artists.items.forEach(a => {
          const img = a.images && a.images[0] ? esc(a.images[0].url) : '';
          html += \`<div class="result-item" onclick="searchArtistTracks('\${esc(a.id)}', '\${esc(a.name)}')">
            \${img ? \`<img class="result-img round" src="\${img}" alt="" />\` : '<div class="result-img round skeleton"></div>'}
            <div class="result-text">
              <div class="result-name">\${esc(a.name)}</div>
              <div class="result-sub">Artista</div>
            </div>
          </div>\`;
        });
        html += '</div>';
      }
      if (data.playlists && data.playlists.items && data.playlists.items.length) {
        html += '<div class="results-section"><div class="results-section-title">Playlists</div>';
        data.playlists.items.forEach(p => {
          if (!p) return;
          const img = p.images && p.images[0] ? esc(p.images[0].url) : '';
          html += \`<div class="result-item" onclick="playContext('\${esc(p.uri)}')">
            \${img ? \`<img class="result-img" src="\${img}" alt="" />\` : '<div class="result-img skeleton"></div>'}
            <div class="result-text">
              <div class="result-name">\${esc(p.name)}</div>
              <div class="result-sub">\${esc(p.description || 'Playlist')}</div>
            </div>
          </div>\`;
        });
        html += '</div>';
      }
      if (!html) {
        html = '<div class="empty-state">Sin resultados para "' + esc(q) + '"</div>';
      }
      container.innerHTML = html;
    }

    async function searchArtistTracks(artistId, artistName) {
      const container = document.getElementById('search-results');
      container.innerHTML = renderSkeletons(5);
      const data = await api('GET', '/api/search?q=' + encodeURIComponent('artist:' + artistName) + '&type=track');
      if (!data || !data.tracks || !data.tracks.items || !data.tracks.items.length) {
        container.innerHTML = '<div class="empty-state">Sin canciones encontradas</div>';
        return;
      }
      let html = '<div class="results-section"><div class="results-section-title">' + esc(artistName) + '</div>';
      data.tracks.items.forEach(t => {
        const img = t.album && t.album.images && t.album.images[0]
          ? esc(t.album.images[0].url) : '';
        const active = t.id === currentTrackId ? ' now-playing' : '';
        html += \`<div class="result-item\${active}" onclick="playUri('\${esc(t.uri)}')">
          \${img ? \`<img class="result-img" src="\${img}" alt="" />\` : '<div class="result-img skeleton"></div>'}
          <div class="result-text">
            <div class="result-name">\${esc(t.name)}</div>
            <div class="result-sub">\${esc(t.album ? t.album.name : '')}</div>
          </div>
        </div>\`;
      });
      html += '</div>';
      container.innerHTML = html;
    }

    // ── Playback actions ───────────────────────────────────────────────────
    async function playUri(uri) {
      closeAllSheets();
      await api('POST', '/api/play-uri', { uri });
      setTimeout(poll, 500);
      resetPoll();
    }

    async function playContext(contextUri) {
      closeAllSheets();
      await api('POST', '/api/play-uri', { context_uri: contextUri });
      setTimeout(poll, 500);
      resetPoll();
    }

    // ── Queue ──────────────────────────────────────────────────────────────
    async function loadQueue() {
      const container = document.getElementById('queue-list');
      container.innerHTML = renderSkeletons(6);
      const data = await api('GET', '/api/queue');
      if (!data) {
        container.innerHTML = '<div class="empty-state">No se pudo cargar la cola</div>';
        return;
      }
      let html = '';
      if (data.currently_playing) {
        const cp = data.currently_playing;
        const img = cp.album && cp.album.images && cp.album.images[0]
          ? esc(cp.album.images[0].url) : '';
        const artist = cp.artists ? cp.artists.map(a => a.name).join(', ') : '';
        html += '<div class="queue-section-label">Sonando ahora</div>';
        html += \`<div class="queue-item current">
          \${img ? \`<img class="queue-img" src="\${img}" alt="" />\` : '<div class="queue-img skeleton"></div>'}
          <div class="queue-text">
            <div class="queue-name">\${esc(cp.name)}</div>
            <div class="queue-sub">\${esc(artist)}</div>
          </div>
        </div>\`;
      }
      if (data.queue && data.queue.length) {
        html += '<div class="queue-section-label">A continuación</div>';
        data.queue.forEach((t, i) => {
          if (i >= 20) return;
          const img = t.album && t.album.images && t.album.images[0]
            ? esc(t.album.images[0].url) : '';
          const artist = t.artists ? t.artists.map(a => a.name).join(', ') : '';
          html += \`<div class="queue-item" onclick="playUri('\${esc(t.uri)}')">
            \${img ? \`<img class="queue-img" src="\${img}" alt="" />\` : '<div class="queue-img skeleton"></div>'}
            <div class="queue-text">
              <div class="queue-name">\${esc(t.name)}</div>
              <div class="queue-sub">\${esc(artist)}</div>
            </div>
          </div>\`;
        });
      }
      if (!html) {
        html = '<div class="empty-state">Cola vacía</div>';
      }
      container.innerHTML = html;
    }

    // ── Helpers ────────────────────────────────────────────────────────────
    function esc(s) {
      if (s == null) return '';
      const d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    }

    function renderSkeletons(n) {
      let out = '';
      for (let i = 0; i < n; i++) {
        out += \`<div class="skeleton-item">
          <div class="skeleton skeleton-img"></div>
          <div class="skeleton-text">
            <div class="skeleton skeleton-line-a"></div>
            <div class="skeleton skeleton-line-b"></div>
          </div>
        </div>\`;
      }
      return out;
    }

    // ── Visibility ─────────────────────────────────────────────────────────
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        pollInterval = 15000;
      } else {
        pollInterval = 5000;
        poll();
      }
      resetPoll();
    });
  </script>
</body>
</html>`;
}
