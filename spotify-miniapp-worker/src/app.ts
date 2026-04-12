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
      background: #0f0a1a;
      color: #fff;
      overflow: hidden;
      height: 100vh;
      height: var(--tg-viewport-stable-height, 100dvh);
      position: relative;
    }

    body.light {
      background: var(--tg-bg-color, #f0f0f0);
      color: var(--tg-text-color, #000);
    }

    body.light #track-artist {
      color: var(--tg-hint-color, #707070);
    }

    body.light #track-album {
      color: var(--tg-hint-color, #909090);
    }

    #bg-gradient {
      position: fixed;
      inset: 0;
      background: linear-gradient(160deg, #0f0a1a 0%, #1a1040 50%, #0d1b3e 100%);
      transition: background 1.5s ease;
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
      height: var(--tg-viewport-stable-height, 100dvh);
      padding: calc(20px + var(--safe-area-top, 0px)) 24px calc(16px + var(--safe-area-bottom, 0px));
      max-width: 480px;
      margin: 0 auto;
    }

    /* Album art */
    #album-art {
      width: min(260px, 62vw);
      height: min(260px, 62vw);
      border-radius: 20px;
      object-fit: cover;
      box-shadow: 0 28px 72px rgba(0,0,0,0.6), 0 8px 24px rgba(0,0,0,0.4);
      display: none;
      flex-shrink: 0;
    }

    #album-art-placeholder {
      width: min(260px, 62vw);
      height: min(260px, 62vw);
      border-radius: 20px;
      background: rgba(255,255,255,0.06);
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(255,255,255,0.3);
      flex-shrink: 0;
    }

    /* Track info */
    #track-info {
      width: 100%;
      text-align: center;
      padding: 0 8px;
    }

    #track-name {
      font-size: 20px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 5px;
      color: #fff;
    }

    #track-artist {
      font-size: 15px;
      color: #b0b0c0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 3px;
    }

    #track-album {
      font-size: 13px;
      color: #707088;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Progress */
    #progress-container {
      width: 100%;
    }

    #progress-bar-bg {
      width: 100%;
      height: 3px;
      background: rgba(255,255,255,0.18);
      border-radius: 3px;
      cursor: pointer;
      position: relative;
      transition: height 0.15s ease;
    }

    #progress-bar-bg:hover,
    #progress-bar-bg:active {
      height: 5px;
    }

    #progress-bar {
      height: 100%;
      border-radius: 3px;
      background: #1DB954;
      pointer-events: none;
      transition: width 0.1s linear;
    }

    #progress-times {
      display: flex;
      justify-content: space-between;
      margin-top: 8px;
      font-size: 11px;
      color: rgba(255,255,255,0.45);
    }

    /* Glass controls panel */
    #controls-panel {
      width: 100%;
      background: rgba(255,255,255,0.07);
      backdrop-filter: blur(30px);
      -webkit-backdrop-filter: blur(30px);
      border-radius: 24px;
      border: 1px solid rgba(255,255,255,0.1);
      padding: 20px 20px 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    #controls {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: 100%;
    }

    .ctrl-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: transparent;
      color: rgba(255,255,255,0.75);
      cursor: pointer;
      transition: color 0.15s ease, transform 0.1s ease, opacity 0.15s ease;
      flex-shrink: 0;
      padding: 6px;
      border-radius: 50%;
    }

    .ctrl-btn:active {
      transform: scale(0.88);
      opacity: 0.7;
    }

    .ctrl-btn:hover {
      color: #fff;
    }

    #btn-play {
      width: 56px;
      height: 56px;
      background: rgba(255,255,255,0.12);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border-radius: 50%;
      color: #fff;
      padding: 0;
    }

    #btn-play:hover {
      background: rgba(255,255,255,0.2);
    }

    .ctrl-active {
      color: #1DB954 !important;
    }

    /* Volume */
    #volume-container {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
    }

    .vol-icon {
      color: rgba(255,255,255,0.45);
      flex-shrink: 0;
      display: flex;
      align-items: center;
    }

    input[type=range] {
      -webkit-appearance: none;
      appearance: none;
      flex: 1;
      height: 3px;
      background: rgba(255,255,255,0.2);
      border-radius: 3px;
      outline: none;
      cursor: pointer;
    }

    input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 13px;
      height: 13px;
      border-radius: 50%;
      background: #fff;
      cursor: pointer;
      box-shadow: 0 0 4px rgba(0,0,0,0.4);
    }

    input[type=range]::-moz-range-thumb {
      width: 13px;
      height: 13px;
      border-radius: 50%;
      background: #fff;
      cursor: pointer;
      border: none;
    }

    /* Nav bar */
    #nav-bar {
      display: flex;
      gap: 10px;
      width: 100%;
    }

    .nav-btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      padding: 11px 8px;
      border: none;
      background: rgba(255,255,255,0.08);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-radius: 50px;
      color: rgba(255,255,255,0.6);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
      border: 1px solid rgba(255,255,255,0.08);
    }

    .nav-btn:hover {
      background: rgba(255,255,255,0.14);
      color: #fff;
    }

    .nav-btn:active {
      background: rgba(255,255,255,0.2);
    }

    .nav-btn.nav-active {
      background: rgba(29,185,84,0.2);
      color: #1DB954;
      border-color: rgba(29,185,84,0.3);
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
      background: rgba(12, 8, 30, 0.97);
      backdrop-filter: blur(40px);
      -webkit-backdrop-filter: blur(40px);
      border-radius: 20px 20px 0 0;
      border-top: 1px solid rgba(255,255,255,0.1);
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
      background: rgba(255,255,255,0.25);
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
      background: rgba(255,255,255,0.12);
      color: rgba(255,255,255,0.7);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease;
    }

    .sheet-close:hover {
      background: rgba(255,255,255,0.2);
      color: #fff;
    }

    .sheet-body {
      flex: 1;
      overflow-y: auto;
      padding: 0 16px 32px;
    }

    .sheet-body::-webkit-scrollbar { display: none; }

    /* Search */
    .search-input-wrapper {
      position: sticky;
      top: 0;
      background: transparent;
      padding: 4px 0 12px;
      margin-bottom: 4px;
    }

    .search-input {
      width: 100%;
      padding: 12px 16px 12px 16px;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 14px;
      color: #fff;
      font-size: 15px;
      outline: none;
    }

    .search-input::placeholder {
      color: rgba(255,255,255,0.35);
    }

    .search-input:focus {
      border-color: rgba(29,185,84,0.45);
      background: rgba(255,255,255,0.1);
    }

    /* Results */
    .results-section {
      margin-bottom: 16px;
    }

    .results-section-title {
      font-size: 12px;
      font-weight: 600;
      color: rgba(255,255,255,0.45);
      text-transform: uppercase;
      letter-spacing: 0.07em;
      margin-bottom: 8px;
      padding: 0 4px;
    }

    .result-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 8px;
      border-radius: 12px;
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .result-item:hover, .result-item:active {
      background: rgba(255,255,255,0.08);
    }

    .result-item.now-playing {
      background: rgba(29,185,84,0.12);
    }

    .result-img {
      width: 44px;
      height: 44px;
      border-radius: 8px;
      object-fit: cover;
      flex-shrink: 0;
      background: rgba(255,255,255,0.08);
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
      color: rgba(255,255,255,0.45);
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
      border-radius: 12px;
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .queue-item:hover {
      background: rgba(255,255,255,0.07);
    }

    .queue-item.now-playing {
      background: rgba(29,185,84,0.12);
    }

    .queue-item.now-playing .queue-name {
      color: #1DB954;
    }

    .queue-img {
      width: 44px;
      height: 44px;
      border-radius: 8px;
      object-fit: cover;
      flex-shrink: 0;
      background: rgba(255,255,255,0.08);
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
      color: rgba(255,255,255,0.45);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 2px;
    }

    .queue-np-label {
      font-size: 11px;
      font-weight: 700;
      color: rgba(255,255,255,0.3);
      text-transform: uppercase;
      letter-spacing: 0.07em;
      padding: 14px 8px 6px;
    }

    /* Skeleton */
    .skeleton {
      background: rgba(255,255,255,0.07);
      border-radius: 6px;
      position: relative;
      overflow: hidden;
    }

    .skeleton::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.07) 50%, transparent 100%);
      animation: shimmer 1.5s infinite;
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
      border-radius: 8px;
      flex-shrink: 0;
    }

    .skeleton-text { flex: 1; }
    .skeleton-line-a { height: 14px; border-radius: 4px; margin-bottom: 7px; width: 65%; }
    .skeleton-line-b { height: 12px; border-radius: 4px; width: 42%; }

    /* Empty state */
    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 48px 20px;
      color: rgba(255,255,255,0.3);
      font-size: 14px;
      text-align: center;
    }

    /* Toast */
    #toast {
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: rgba(30, 20, 60, 0.92);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.15);
      color: #fff;
      padding: 10px 20px;
      border-radius: 50px;
      font-size: 14px;
      font-weight: 500;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s ease, transform 0.3s ease;
      z-index: 100;
      white-space: nowrap;
    }

    #toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  </style>
</head>
<body>
  <div id="bg-gradient"></div>
  <div id="bg-blur"></div>

  <div id="player">
    <!-- Album art -->
    <img id="album-art" src="" alt="" />
    <div id="album-art-placeholder">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3" fill="currentColor"/><circle cx="18" cy="16" r="3" fill="currentColor"/></svg>
    </div>

    <!-- Track info -->
    <div id="track-info">
      <div id="track-name">No hay nada sonando</div>
      <div id="track-artist">—</div>
      <div id="track-album"></div>
    </div>

    <!-- Progress bar -->
    <div id="progress-container">
      <div id="progress-bar-bg" onclick="seekTo(event)">
        <div id="progress-bar" style="width:0%"></div>
      </div>
      <div id="progress-times">
        <span id="time-elapsed">0:00</span>
        <span id="time-total">0:00</span>
      </div>
    </div>

    <!-- Glass controls panel -->
    <div id="controls-panel">
      <div id="controls">
        <button class="ctrl-btn" id="btn-shuffle" onclick="toggleShuffle()" title="Shuffle">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>
        </button>
        <button class="ctrl-btn" onclick="skipTrack(&apos;previous&apos;)" title="Anterior">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="19,20 9,12 19,4" fill="currentColor" stroke="none"/><line x1="5" y1="4" x2="5" y2="20"/></svg>
        </button>
        <button class="ctrl-btn" id="btn-play" onclick="togglePlay()" title="Play/Pause">
          <svg id="icon-play" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6,3 20,12 6,21"/></svg>
          <svg id="icon-pause" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none" style="display:none"><rect x="5" y="3" width="4" height="18" rx="1"/><rect x="15" y="3" width="4" height="18" rx="1"/></svg>
        </button>
        <button class="ctrl-btn" onclick="skipTrack(&apos;next&apos;)" title="Siguiente">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="5,4 15,12 5,20" fill="currentColor" stroke="none"/><line x1="19" y1="4" x2="19" y2="20"/></svg>
        </button>
        <button class="ctrl-btn" id="btn-repeat" onclick="toggleRepeat()" title="Repeat">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>
        </button>
      </div>
      <div id="volume-container">
        <span class="vol-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="11,5 6,9 2,9 2,15 6,15 11,19" fill="currentColor"/><path d="M15.54 8.46a5 5 0 010 7.07"/></svg>
        </span>
        <input type="range" id="volume-slider" min="0" max="100" value="50" oninput="setVolume(this.value)" />
        <span class="vol-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="11,5 6,9 2,9 2,15 6,15 11,19" fill="currentColor"/><path d="M15.54 8.46a5 5 0 010 7.07"/><path d="M19.07 4.93a10 10 0 010 14.14"/></svg>
        </span>
      </div>
    </div>

    <!-- Nav bar -->
    <div id="nav-bar">
      <button class="nav-btn" id="nav-search" onclick="openSheet(&apos;search&apos;)">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        Buscar
      </button>
      <button class="nav-btn nav-active" id="nav-playing">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3" fill="currentColor"/><circle cx="18" cy="16" r="3" fill="currentColor"/></svg>
        Sonando
      </button>
      <button class="nav-btn" id="nav-queue" onclick="openSheet(&apos;queue&apos;)">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
        Cola
      </button>
    </div>
  </div>

  <!-- Toast -->
  <div id="toast"></div>

  <!-- Search sheet -->
  <div class="sheet-overlay" id="overlay-search" onclick="closeSheet(&apos;search&apos;)"></div>
  <div class="sheet" id="sheet-search">
    <div class="sheet-handle"></div>
    <div class="sheet-header">
      <span class="sheet-title">Buscar</span>
      <button class="sheet-close" onclick="closeSheet(&apos;search&apos;)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="sheet-body">
      <div class="search-input-wrapper">
        <input class="search-input" id="search-input" type="text"
               placeholder="Artistas, canciones, playlists..."
               oninput="debounceSearch(this.value)" />
      </div>
      <div id="search-results"></div>
    </div>
  </div>

  <!-- Queue sheet -->
  <div class="sheet-overlay" id="overlay-queue" onclick="closeSheet(&apos;queue&apos;)"></div>
  <div class="sheet" id="sheet-queue">
    <div class="sheet-handle"></div>
    <div class="sheet-header">
      <span class="sheet-title">Cola de reproducción</span>
      <button class="sheet-close" onclick="closeSheet(&apos;queue&apos;)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
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
    let toastTimer = null;

    // ── Theme helpers ──────────────────────────────────────────────────────
    function applyTheme() {
      if (!window.Telegram || !Telegram.WebApp) return;
      const twa = Telegram.WebApp;
      // colorScheme
      if (twa.colorScheme === 'light') {
        document.body.classList.add('light');
      } else {
        document.body.classList.remove('light');
      }
      // themeParams
      const tp = twa.themeParams || {};
      const root = document.documentElement;
      if (tp.bg_color) root.style.setProperty('--tg-bg-color', tp.bg_color);
      if (tp.text_color) root.style.setProperty('--tg-text-color', tp.text_color);
      if (tp.hint_color) root.style.setProperty('--tg-hint-color', tp.hint_color);
      if (tp.button_color) root.style.setProperty('--tg-button-color', tp.button_color);
    }

    function applySafeArea() {
      if (!window.Telegram || !Telegram.WebApp) return;
      const twa = Telegram.WebApp;
      const root = document.documentElement;
      const sa = twa.safeAreaInset || {};
      root.style.setProperty('--safe-area-top', (sa.top || 0) + 'px');
      root.style.setProperty('--safe-area-bottom', (sa.bottom || 0) + 'px');
      root.style.setProperty('--safe-area-left', (sa.left || 0) + 'px');
      root.style.setProperty('--safe-area-right', (sa.right || 0) + 'px');
      // contentSafeAreaInset if available (Bot API 7.10+)
      const csa = twa.contentSafeAreaInset || {};
      root.style.setProperty('--content-safe-area-top', (csa.top || 0) + 'px');
      root.style.setProperty('--content-safe-area-bottom', (csa.bottom || 0) + 'px');
    }

    // ── Init ───────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
      if (window.Telegram && Telegram.WebApp) {
        Telegram.WebApp.expand();
        Telegram.WebApp.ready();
        if (Telegram.WebApp.disableVerticalSwipes) {
          Telegram.WebApp.disableVerticalSwipes();
        }
        Telegram.WebApp.BackButton.onClick(() => {
          if (document.querySelector('.sheet.open')) {
            closeAllSheets();
          }
        });
        // Apply theme and safe area on init
        applyTheme();
        applySafeArea();
        // Subscribe to theme changes
        Telegram.WebApp.onEvent('themeChanged', applyTheme);
      }
      startPoll();
      startProgressAnimation();
    });

    // ── Toast ──────────────────────────────────────────────────────────────
    function showToast(msg, duration) {
      duration = duration || 3000;
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.classList.add('show');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        el.classList.remove('show');
      }, duration);
    }

    // ── API helper ─────────────────────────────────────────────────────────
    async function api(method, path, body) {
      try {
        const opts = { method, headers: { 'Content-Type': 'application/json' } };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(path, opts);
        if (res.status === 204) return null;
        if (res.status === 404) {
          const text = await res.text();
          if (text && text.includes('NO_ACTIVE_DEVICE')) {
            showToast('Abre Spotify en un dispositivo');
          }
          return null;
        }
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
      updatePlayButton();

      if (newId !== currentTrackId) {
        currentTrackId = newId;
        const imgUrl = track.album && track.album.images && track.album.images[0]
          ? track.album.images[0].url : null;
        if (imgUrl) {
          const img = document.getElementById('album-art');
          img.onload = () => {
            document.getElementById('album-art-placeholder').style.display = 'none';
            img.style.display = 'block';
            extractColors(img);
          };
          img.onerror = () => {
            img.style.display = 'none';
            document.getElementById('album-art-placeholder').style.display = 'flex';
            resetBackground();
          };
          img.src = imgUrl;
        } else {
          document.getElementById('album-art').style.display = 'none';
          document.getElementById('album-art-placeholder').style.display = 'flex';
          resetBackground();
        }
      }
    }

    function showNoPlayback() {
      document.getElementById('track-name').textContent = 'No hay nada sonando';
      document.getElementById('track-artist').textContent = '—';
      document.getElementById('track-album').textContent = '';
      document.getElementById('progress-bar').style.width = '0%';
      document.getElementById('time-elapsed').textContent = '0:00';
      document.getElementById('time-total').textContent = '0:00';
      isPlaying = false;
      currentTrackId = null;
      progressMs = 0;
      durationMs = 0;
      updatePlayButton();
    }

    function updatePlayButton() {
      document.getElementById('icon-play').style.display = isPlaying ? 'none' : 'block';
      document.getElementById('icon-pause').style.display = isPlaying ? 'block' : 'none';
    }

    // ── Progress ───────────────────────────────────────────────────────────
    function updateProgress() {
      if (!durationMs) return;
      const pct = Math.min(100, (progressMs / durationMs) * 100);
      document.getElementById('progress-bar').style.width = pct + '%';
      document.getElementById('time-elapsed').textContent = formatMs(progressMs);
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
      if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
        Telegram.WebApp.HapticFeedback.impactOccurred('medium');
      }
      const endpoint = isPlaying ? '/api/pause' : '/api/play';
      isPlaying = !isPlaying;
      updatePlayButton();
      await api('PUT', endpoint);
      resetPoll();
    }

    async function skipTrack(direction) {
      if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
        Telegram.WebApp.HapticFeedback.impactOccurred('light');
      }
      await api('POST', '/api/' + direction);
      // Re-poll after short delay to let Spotify process the skip
      setTimeout(() => { clearInterval(pollTimer); poll(); pollTimer = setInterval(poll, pollInterval); }, 600);
    }

    function toggleShuffle() {
      const btn = document.getElementById('btn-shuffle');
      btn.classList.toggle('ctrl-active');
    }

    function toggleRepeat() {
      const btn = document.getElementById('btn-repeat');
      btn.classList.toggle('ctrl-active');
    }

    function setVolume(val) {
      if (volumeTimer) clearTimeout(volumeTimer);
      volumeTimer = setTimeout(async () => {
        await api('PUT', '/api/volume?percent=' + encodeURIComponent(val));
      }, 300);
    }

    function seekTo(e) {
      const bg = document.getElementById('progress-bar-bg');
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
        const corners = [0, 3, 12, 15].map(i => {
          const base = i * 4;
          return [d[base], d[base+1], d[base+2]];
        });
        const c0 = corners[0].map(v => Math.floor(v * 0.35));
        const c1 = corners[3].map(v => Math.floor(v * 0.45));
        const grad = \`linear-gradient(160deg, rgb(\${c0.join(',')}) 0%, rgb(\${c1.join(',')}) 100%)\`;
        document.getElementById('bg-gradient').style.background = grad;
      } catch(e) {
        resetBackground();
      }
    }

    function resetBackground() {
      document.getElementById('bg-gradient').style.background =
        'linear-gradient(160deg, #0f0a1a 0%, #1a1040 50%, #0d1b3e 100%)';
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
      if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
        Telegram.WebApp.HapticFeedback.impactOccurred('light');
      }
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
        html += '<div class="queue-np-label">Sonando ahora</div>';
        html += \`<div class="queue-item now-playing">
          \${img ? \`<img class="queue-img" src="\${img}" alt="" />\` : '<div class="queue-img skeleton"></div>'}
          <div class="queue-text">
            <div class="queue-name">\${esc(cp.name)}</div>
            <div class="queue-sub">\${esc(artist)}</div>
          </div>
        </div>\`;
      }
      if (data.queue && data.queue.length) {
        html += '<div class="queue-np-label">A continuación</div>';
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
      return d.innerHTML.replace(/'/g, '&#39;');
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
