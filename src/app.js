const lyricsTarget = document.getElementById('lyrics-target');
const bgImage = document.getElementById('bg-image');
const bgOverlay = document.getElementById('bg-overlay');
const bgInput = document.getElementById('bg-input');
const hostInput = document.getElementById('host-input');
const portInput = document.getElementById('port-input');
const syncOffsetInput = document.getElementById('sync-offset-input');
const debugToggle = document.getElementById('debug-toggle');
const debugTerminal = document.getElementById('debug-terminal');
const jsonViewer = document.getElementById('json-viewer');
const controlsPanel = document.querySelector('.controls-panel');

const LRCLIB_HEADERS = { 'User-Agent': 'PearLyrics/1.0.0 (https://github.com/pear-lyrics-overlay)' };
const API_POLL_MS = 150;
const API_POLL_WS_MS = 2000;
const PEAR_WS_RECONNECT_MS = 3000;
const TIMING_OFFSET_STORAGE_KEY = 'pear-lyrics-timing-lead';
const HOST_STORAGE_KEY = 'pear-api-host';
const DEFAULT_LYRICS_LEAD_SEC = 1;
const LYRICS_CACHE_STORAGE_KEY = 'pear-lyrics-cache-v1';
const LYRICS_CACHE_MAX_ENTRIES = 80;
const ART_CACHE_STORAGE_KEY = 'pear-art-cache-v1';
const ART_CACHE_MAX_ENTRIES = 60;
const ART_MAX_BLOB_BYTES = 280000;

const lyricModeSelect = document.getElementById('lyric-mode-select');
const LYRIC_MODE_STORAGE_KEY = 'pear-lyrics-mode';

function loadLyricMode() {
    return localStorage.getItem(LYRIC_MODE_STORAGE_KEY) || 'word-by-word';
}

let lyricMode = loadLyricMode();
lyricModeSelect.value = lyricMode;
lyricModeSelect.addEventListener('change', () => {
    lyricMode = lyricModeSelect.value;
    localStorage.setItem(LYRIC_MODE_STORAGE_KEY, lyricMode);
    currentLineIndex = -1; // force re-render on next tick
});

const lyricThemeSelect = document.getElementById('lyric-theme-select');
const LYRIC_THEME_STORAGE_KEY = 'pear-lyrics-theme';

function loadLyricTheme() {
    return localStorage.getItem(LYRIC_THEME_STORAGE_KEY) || 'melancholic';
}

let lyricTheme = loadLyricTheme();
lyricThemeSelect.value = lyricTheme;
document.body.dataset.lyricTheme = lyricTheme;
lyricThemeSelect.addEventListener('change', () => {
    lyricTheme = lyricThemeSelect.value;
    localStorage.setItem(LYRIC_THEME_STORAGE_KEY, lyricTheme);
    document.body.dataset.lyricTheme = lyricTheme;
    currentLineIndex = -1; // force re-render on next tick
});

let currentHost = loadApiHost();
let currentPort = portInput.value || '26538';
let currentTrackId = '';
let cachedLyrics = null;
let currentLineIndex = -1;
let isFetchingFallback = false;
let fallbackFailed = false;
let lastPlayerState = null;
let lastSyncWallTime = 0;
let lyricsLeadMs = loadLyricsLeadMs();
let sessionCustomBackground = null;
let currentBackgroundKey = '';
let pearWs = null;
let pearWsConnected = false;
let pearPollTimer = null;
let lastLyricsSource = '';
let wbwTimers = [];
let wbwLineIndex = -1;
const lyricsCacheMemory = loadLyricsCacheFromStorage();
const artCacheMemory = loadArtCacheFromStorage();

function loadApiHost() {
    return localStorage.getItem(HOST_STORAGE_KEY) || '127.0.0.1';
}

function normalizeApiHost(raw) {
    let host = String(raw || '').trim();
    host = host.replace(/^https?:\/\//i, '');
    host = host.replace(/\/.*$/, '');
    return host || '127.0.0.1';
}

function getApiBaseUrl() {
    return `http://${currentHost}:${currentPort}`;
}

function applyConnectionSettings() {
    currentHost = normalizeApiHost(hostInput.value);
    const portVal = portInput.value.trim();
    if (portVal && !Number.isNaN(portVal)) {
        currentPort = portVal;
    }
    localStorage.setItem(HOST_STORAGE_KEY, currentHost);
    resetState();
    connectPearWebSocket();
}

hostInput.value = currentHost;
hostInput.addEventListener('input', applyConnectionSettings);

function loadLyricsLeadMs() {
    const stored = localStorage.getItem(TIMING_OFFSET_STORAGE_KEY);
    const sec = stored != null ? parseFloat(stored) : DEFAULT_LYRICS_LEAD_SEC;
    return Number.isNaN(sec) ? DEFAULT_LYRICS_LEAD_SEC * 1000 : sec * 1000;
}

function getSyncMs(progressMs) {
    return Math.max(0, progressMs + lyricsLeadMs);
}

syncOffsetInput.value = String(lyricsLeadMs / 1000);
syncOffsetInput.addEventListener('input', () => {
    const sec = parseFloat(syncOffsetInput.value);
    lyricsLeadMs = Number.isNaN(sec) ? 0 : sec * 1000;
    localStorage.setItem(TIMING_OFFSET_STORAGE_KEY, String(sec));
    currentLineIndex = -1;
});

function loadArtCacheFromStorage() {
    try {
        const raw = localStorage.getItem(ART_CACHE_STORAGE_KEY);
        return raw ? new Map(Object.entries(JSON.parse(raw))) : new Map();
    } catch {
        return new Map();
    }
}

function persistArtCache() {
    try {
        localStorage.setItem(
            ART_CACHE_STORAGE_KEY,
            JSON.stringify(Object.fromEntries(artCacheMemory))
        );
    } catch (err) {
        console.warn('Art cache save failed:', err);
    }
}

function loadLyricsCacheFromStorage() {
    try {
        const raw = localStorage.getItem(LYRICS_CACHE_STORAGE_KEY);
        return raw ? new Map(Object.entries(JSON.parse(raw))) : new Map();
    } catch {
        return new Map();
    }
}

function persistLyricsCache() {
    try {
        localStorage.setItem(
            LYRICS_CACHE_STORAGE_KEY,
            JSON.stringify(Object.fromEntries(lyricsCacheMemory))
        );
    } catch (err) {
        console.warn('Lyrics cache save failed:', err);
    }
}

function buildCacheKey(state) {
    if (state.videoId) return `vid:${state.videoId}`;
    const title = normalizeTrackTitle(state.title);
    const artist = normalizeArtistName(state.artist);
    const duration = getTrackDurationSec(state);
    return `meta:${title}|${artist}|${duration || 0}`;
}

function lineTimeMs(line) {
    if (line.time != null && !Number.isNaN(Number(line.time))) return Number(line.time);
    if (line.start != null && !Number.isNaN(Number(line.start))) return Number(line.start);
    if (line.timeInMs != null && !Number.isNaN(Number(line.timeInMs))) return Number(line.timeInMs);
    const cue = line.cueRange?.startTimeMilliseconds ?? line.startTimeMilliseconds;
    if (cue != null) return parseInt(cue, 10);
    return 0;
}

function normalizeLinesForStorage(lines) {
    return lines
        .map((line) => ({
            time: lineTimeMs(line),
            text: String(line.text || line.words || line.line || line.lyricLine || '').trim(),
        }))
        .filter((line) => line.text)
        .sort((a, b) => a.time - b.time);
}

function getLyricsFromCache(state) {
    const key = buildCacheKey(state);
    const entry = lyricsCacheMemory.get(key);
    if (!entry?.lines?.length) return null;
    return entry.lines;
}

function saveLyricsToCache(state, lines, source) {
    const key = buildCacheKey(state);
    const normalized = normalizeLinesForStorage(lines);
    if (!normalized.length) return;

    lyricsCacheMemory.set(key, {
        lines: normalized,
        source,
        title: state.title || '',
        artist: state.artist || '',
        savedAt: Date.now(),
    });

    if (lyricsCacheMemory.size > LYRICS_CACHE_MAX_ENTRIES) {
        const oldestKey = [...lyricsCacheMemory.entries()]
            .sort((a, b) => (a[1].savedAt || 0) - (b[1].savedAt || 0))[0]?.[0];
        if (oldestKey) lyricsCacheMemory.delete(oldestKey);
    }

    persistLyricsCache();
}

function applyLyrics(lines, state, source) {
    cachedLyrics = normalizeLinesForStorage(lines);
    lastLyricsSource = source;
    resetPlaybackState();
    saveLyricsToCache(state, cachedLyrics, source);
}

function extractCoverUrl(state) {
    const candidates = [
        state.imageSrc,
        state.cover,
        state.coverArt,
        state.albumCover,
        state.thumbnail,
        state.artwork,
    ];
    for (const value of candidates) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    if (state.videoId) {
        return `https://i.ytimg.com/vi/${state.videoId}/maxresdefault.jpg`;
    }
    return null;
}

function applyBackgroundImage(url) {
    if (!url) return;
    bgImage.style.backgroundImage = `url(${JSON.stringify(url)})`;
}

// Toggling this class only visibly pulses the background under the "vivid"
// theme (see body[data-lyric-theme="vivid"] rules in style.css) — melancholic
// keeps just the slow continuous drift, so this is safe to always call.
function pulseBackground() {
    [bgImage, bgOverlay].forEach((el) => {
        el.classList.remove('bg-pulse');
        // Force reflow so the animation restarts even if it's still mid-pulse
        void el.offsetWidth;
        el.classList.add('bg-pulse');
    });
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function getArtFromCache(key) {
    return artCacheMemory.get(key) || null;
}

function saveArtToCache(key, entry) {
    artCacheMemory.set(key, entry);
    if (artCacheMemory.size > ART_CACHE_MAX_ENTRIES) {
        const oldestKey = [...artCacheMemory.entries()]
            .sort((a, b) => (a[1].savedAt || 0) - (b[1].savedAt || 0))[0]?.[0];
        if (oldestKey) artCacheMemory.delete(oldestKey);
    }
    persistArtCache();
}

async function resolveAndCacheCover(state) {
    if (sessionCustomBackground) {
        applyBackgroundImage(sessionCustomBackground);
        return;
    }

    const key = buildCacheKey(state);
    const coverUrl = extractCoverUrl(state);
    if (!coverUrl) return;

    const cached = getArtFromCache(key);

    if (key === currentBackgroundKey && cached?.url === coverUrl) {
        applyBackgroundImage(cached?.dataUrl || coverUrl);
        return;
    }

    currentBackgroundKey = key;
    applyBackgroundImage(cached?.dataUrl || coverUrl);

    if (cached?.url === coverUrl && cached?.dataUrl) {
        saveArtToCache(key, cached);
        return;
    }

    saveArtToCache(key, { url: coverUrl, savedAt: Date.now(), dataUrl: null });

    try {
        const response = await fetch(coverUrl, { mode: 'cors' });
        if (!response.ok) return;
        const blob = await response.blob();
        if (blob.size > ART_MAX_BLOB_BYTES) return;

        const dataUrl = await blobToDataUrl(blob);
        saveArtToCache(key, { url: coverUrl, dataUrl, savedAt: Date.now() });
        if (currentBackgroundKey === key && !sessionCustomBackground) {
            applyBackgroundImage(dataUrl);
        }
    } catch {
        // Pear / YouTube URL still shown if image fetch is blocked
    }
}

debugToggle.addEventListener('change', (e) => {
    debugTerminal.classList.toggle('hidden', !e.target.checked);
});

document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
        return;
    }
    e.preventDefault();
    controlsPanel.classList.toggle('controls-panel--hidden');
});

portInput.addEventListener('input', applyConnectionSettings);

bgInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => {
            sessionCustomBackground = ev.target.result;
            applyBackgroundImage(sessionCustomBackground);
        };
        reader.readAsDataURL(file);
    }
});

function resetPlaybackState() {
    currentLineIndex = -1;
    isFetchingFallback = false;
    fallbackFailed = false;
    lastPlayerState = null;
    lastSyncWallTime = 0;
    clearWbwTimers();
    wbwLineIndex = -1;
}

function resetState() {
    currentTrackId = '';
    currentBackgroundKey = '';
    cachedLyrics = null;
    resetPlaybackState();
}

function normalizePearState(song, extra = {}) {
    const s = song && typeof song === 'object' ? song : {};
    const paused =
        extra.isPlaying === false ||
        s.isPaused === true ||
        extra.paused === true;
    return {
        ...s,
        title: s.title || extra.title,
        artist: s.artist || extra.artist,
        videoId: s.videoId || extra.videoId,
        songDuration: s.songDuration ?? s.duration ?? extra.songDuration,
        elapsedSeconds:
            extra.position != null
                ? extra.position
                : (s.elapsedSeconds ?? extra.elapsedSeconds),
        isPaused: paused,
        imageSrc: s.imageSrc ?? s.image ?? extra.imageSrc,
        album: s.album ?? extra.album,
    };
}

function normalizeTrackTitle(title) {
    if (!title) return '';
    return title
        .replace(/\s*[\(\[][^\)\]]*(official|video|audio|lyric|visualizer|hd|4k|topic)[^\)\]]*[\)\]]\s*/gi, ' ')
        .replace(/\s*-\s*topic\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeArtistName(artist) {
    if (!artist) return '';
    return artist
        .replace(/\s*-\s*topic\s*$/i, '')
        .replace(/\s*(,|&|\band\b|\bet\b)\s*/gi, ', ')
        .trim();
}

function getTrackDurationSec(state) {
    const candidates = [
        state.songDuration,
        state.duration,
        state.lengthSeconds,
        state.length,
        state.totalDuration,
    ];
    for (const value of candidates) {
        if (value != null && !Number.isNaN(Number(value)) && Number(value) > 0) {
            const num = Number(value);
            return num > 10000 ? Math.round(num / 1000) : Math.round(num);
        }
    }
    return null;
}

function getPlaybackMs(state) {
    if (state.elapsedSeconds != null && !Number.isNaN(state.elapsedSeconds)) return state.elapsedSeconds * 1000;
    if (state.elapsedTime != null) return state.elapsedTime;
    if (state.progress != null) return state.progress;
    return 0;
}

function isPlayerPaused(state) {
    return state.isPaused === true || state.paused === true;
}

function syncPlaybackAnchor(state) {
    lastPlayerState = state;
    lastSyncWallTime = performance.now();
}

function getInterpolatedPlaybackMs() {
    if (!lastPlayerState) return 0;
    const base = getPlaybackMs(lastPlayerState);
    if (isPlayerPaused(lastPlayerState)) return base;
    return base + (performance.now() - lastSyncWallTime);
}

function updateDebugPanel(payload, errMessage) {
    if (!debugToggle.checked) return;
    const header = [
        `Pear API: pas de paroles dans /song (métadonnées + sync uniquement).`,
        `Source paroles: ${lastLyricsSource || '—'}`,
        `WebSocket: ${pearWsConnected ? 'connecté' : 'déconnecté'}`,
        '',
    ].join('\n');
    if (errMessage) {
        jsonViewer.innerText = `${header}Offline: ${errMessage}`;
        return;
    }
    jsonViewer.innerText = `${header}${JSON.stringify(payload, null, 2)}`;
}

function handlePearWsMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'POSITION_CHANGED' && typeof msg.position === 'number') {
        if (lastPlayerState) {
            lastPlayerState.elapsedSeconds = msg.position;
            lastSyncWallTime = performance.now();
        }
        return;
    }

    if (msg.type === 'PLAYER_STATE_CHANGED') {
        if (lastPlayerState && typeof msg.isPlaying === 'boolean') {
            lastPlayerState.isPaused = !msg.isPlaying;
            if (typeof msg.position === 'number') lastPlayerState.elapsedSeconds = msg.position;
            lastSyncWallTime = performance.now();
        }
        return;
    }

    if (msg.song) {
        const state = normalizePearState(msg.song, {
            position: msg.position,
            isPlaying: msg.isPlaying,
        });
        updateDebugPanel(state);
        processTrackState(state);
    }
}

function connectPearWebSocket() {
    if (pearWs) {
        pearWs.onclose = null;
        pearWs.close();
        pearWs = null;
    }
    pearWsConnected = false;

    const wsUrl = `ws://${currentHost}:${currentPort}/api/v1/ws`;
    try {
        const socket = new WebSocket(wsUrl);
        pearWs = socket;

        socket.onopen = () => {
            pearWsConnected = true;
            schedulePearPolling();
        };

        socket.onmessage = (event) => {
            try {
                handlePearWsMessage(JSON.parse(event.data));
            } catch (err) {
                console.warn('Pear WS parse error:', err);
            }
        };

        socket.onclose = () => {
            pearWsConnected = false;
            pearWs = null;
            schedulePearPolling();
            setTimeout(connectPearWebSocket, PEAR_WS_RECONNECT_MS);
        };

        socket.onerror = () => {
            socket.close();
        };
    } catch (err) {
        console.warn('Pear WS connect failed:', err);
        setTimeout(connectPearWebSocket, PEAR_WS_RECONNECT_MS);
    }
}

async function pollPearAPI() {
    const targetUrl = `${getApiBaseUrl()}/api/v1/song`;
    try {
        const response = await fetch(targetUrl, { mode: 'cors' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const state = normalizePearState(data);

        updateDebugPanel(state);
        processTrackState(state);
    } catch (err) {
        updateDebugPanel(null, err.message);
        lyricsTarget.innerHTML = `<div class="lyric-line animation-pulse" style="opacity: 0.4; font-size: 1.6rem;">Awaiting ${currentHost}:${currentPort}...</div>`;
    }
}

function processTrackState(state) {
    const trackIdentifier = state.videoId || `${state.title}|${state.artist}`;

    if (trackIdentifier !== currentTrackId) {
        resetPlaybackState();
        currentTrackId = trackIdentifier;
        currentBackgroundKey = '';
        cachedLyrics = getLyricsFromCache(state);
    }

    resolveAndCacheCover(state);

    if ((!cachedLyrics || cachedLyrics.length === 0) && !isFetchingFallback && !fallbackFailed && state.title) {
        fetchOnlineSyncedFallback(state);
        lyricsTarget.innerHTML = `<div class="lyric-line animation-pulse" style="font-size: 2.2rem; opacity: 0.6;">Searching synced lyrics...</div>`;
        return;
    }

    if (!cachedLyrics || cachedLyrics.length === 0) {
        if (isFetchingFallback) return;
        lastPlayerState = null;
        lyricsTarget.innerHTML = `<div class="lyric-line" style="opacity: 0.4; font-size: 2.2rem;">No synced lines found for this track</div>`;
        return;
    }

    syncPlaybackAnchor(state);
}

async function fetchOnlineSyncedFallback(state) {
    isFetchingFallback = true;
    const cached = getLyricsFromCache(state);
    if (cached?.length) {
        applyLyrics(cached, state, 'cache');
        isFetchingFallback = false;
        return;
    }

    const title = normalizeTrackTitle(state.title);
    const artist = normalizeArtistName(state.artist);
    const album = state.album || state.albumName || '';
    const durationSec = getTrackDurationSec(state);

    try {
        if (durationSec) {
            const getUrl = new URL('https://lrclib.net/api/get');
            getUrl.searchParams.set('track_name', title);
            getUrl.searchParams.set('artist_name', artist);
            getUrl.searchParams.set('album_name', album);
            getUrl.searchParams.set('duration', String(durationSec));

            const getRes = await fetch(getUrl, { headers: LRCLIB_HEADERS });
            if (getRes.ok) {
                const track = await getRes.json();
                if (track.syncedLyrics) {
                    applyLyrics(parseLRCString(track.syncedLyrics), state, 'lrclib');
                    return;
                }
            }
        }

        const searchUrl = new URL('https://lrclib.net/api/search');
        searchUrl.searchParams.set('track_name', title);
        if (artist) searchUrl.searchParams.set('artist_name', artist);

        const res = await fetch(searchUrl, { headers: LRCLIB_HEADERS });
        if (!res.ok) { fallbackFailed = true; return; }

        const results = await res.json();
        if (!results || results.length === 0) { fallbackFailed = true; return; }

        const withSync = results.filter((track) => track.syncedLyrics);
        let bestMatch = withSync.find((track) => durationSec && track.duration && Math.abs(track.duration - durationSec) <= 3);
        if (!bestMatch) bestMatch = withSync[0];
        if (!bestMatch) bestMatch = results[0];

        if (bestMatch?.syncedLyrics) {
            applyLyrics(parseLRCString(bestMatch.syncedLyrics), state, 'lrclib');
        } else {
            fallbackFailed = true;
        }
    } catch (err) {
        console.error('Fallback engine error:', err);
        fallbackFailed = true;
    } finally {
        isFetchingFallback = false;
    }
}

function parseLRCString(lrcText) {
    const lines = lrcText.split('\n');
    const processedLines = [];
    const timeRegex = /\[(\d+):(\d{2})(?:\.(\d{1,3}))?\]/g;

    lines.forEach((line) => {
        const timestamps = [];
        let match;
        while ((match = timeRegex.exec(line)) !== null) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const frac = match[3] ? match[3].padEnd(3, '0').substring(0, 3) : '000';
            const ms = parseInt(frac, 10);
            timestamps.push((minutes * 60 + seconds) * 1000 + ms);
        }
        const text = line.replace(/\[(\d+):(\d{2})(?:\.(\d{1,3}))?\]/g, '').trim();
        if (text && timestamps.length > 0) {
            timestamps.forEach((time) => processedLines.push({ time, text }));
        }
    });
    return processedLines.sort((a, b) => a.time - b.time);
}

function getLineStartMs(index) {
    return cachedLyrics[index].time ?? 0;
}

function getLineText(line) {
    const raw = line.text || line.words || line.line || '';
    if (Array.isArray(raw)) return raw.join(' ');
    return String(raw).trim();
}

function renderTimestamps(progressMs) {
    const syncMs = getSyncMs(progressMs);

    let activeIndex = -1;
    for (let i = 0; i < cachedLyrics.length; i++) {
        if (syncMs >= getLineStartMs(i)) {
            activeIndex = i;
        } else {
            break;
        }
    }

    if (activeIndex === -1) {
        if (currentLineIndex !== -1) {
            currentLineIndex = -1;
            lyricsTarget.innerHTML = '';
        }
        return;
    }

    if (activeIndex === currentLineIndex) {
        return;
    }

    const text = getLineText(cachedLyrics[activeIndex]);
    if (!text) return;

    // Available time until the next line starts
    let availableMs = 4000; // fallback for last line
    if (activeIndex + 1 < cachedLyrics.length) {
        availableMs = getLineStartMs(activeIndex + 1) - getLineStartMs(activeIndex);
    }

    currentLineIndex = activeIndex;
    pulseBackground();
    startWordByWord(text, availableMs, activeIndex);
}

// Word-by-word state (declared at top of file)

function clearWbwTimers() {
    wbwTimers.forEach(clearTimeout);
    wbwTimers = [];
}

// Deterministic pseudo-random in [0, 1) so a given word/line keeps the same
// "chaotic" tilt/drift across re-renders instead of jittering every frame.
function seededRand(seed) {
    const x = Math.sin(seed * 12.9898) * 43758.5453;
    return x - Math.floor(x);
}

function applyWordChaos(span, lineIndex, wordIndex) {
    const tilt = (seededRand(lineIndex * 97 + wordIndex * 13 + 1) * 2 - 1) * 14;
    const drift = (seededRand(lineIndex * 131 + wordIndex * 17 + 50) * 2 - 1) * 26;
    const restTilt = (seededRand(lineIndex * 173 + wordIndex * 19 + 90) * 2 - 1) * 3;
    span.style.setProperty('--word-tilt', `${tilt.toFixed(2)}deg`);
    span.style.setProperty('--word-drift', `${drift.toFixed(2)}px`);
    span.style.setProperty('--word-rest-tilt', `${restTilt.toFixed(2)}deg`);
}

function startWordByWord(textString, availableMs, lineIndex) {
    clearWbwTimers();
    wbwLineIndex = lineIndex;
    lyricsTarget.innerHTML = '';

    const words = textString.split(/\s+/).filter(Boolean);
    if (!words.length) return;

    const wordCount = words.length;

    // Each word gets an equal time slot across the line duration
    // Clamp slot between 80ms (very fast) and 600ms (slow/relaxed)
    const rawSlotMs = availableMs / wordCount;
    // Build-up mode runs a bit faster (max 400ms per word vs 600ms for word-by-word)
    const maxSlotMs = lyricMode === 'build-up' ? 400 : 600;
    const slotMs = Math.max(80, Math.min(maxSlotMs, rawSlotMs));

    // The entrance animations are deliberately slow/heavy for a dramatic feel,
    // but they must still fully resolve (blur -> 0) before the word is swapped
    // out, or fast lyrics end up looking permanently blurry. Scale the actual
    // animation duration to whatever slot this word gets, capped at the full
    // "dramatic" length for slower lines.
    const burstMs = Math.max(120, Math.min(500, slotMs * 0.85));
    const lineMs = Math.max(160, Math.min(1300, slotMs * 0.95));

    if (lyricMode === 'build-up') {
        words.forEach((word, index) => {
            const delay = index * slotMs;
            const t = setTimeout(() => {
                if (wbwLineIndex !== lineIndex) return;
                showBuildUp(words, index, burstMs, lineMs, lineIndex);
            }, delay);
            wbwTimers.push(t);
        });
    } else {
        words.forEach((word, index) => {
            const delay = index * slotMs;
            const t = setTimeout(() => {
                if (wbwLineIndex !== lineIndex) return;
                showSingleWord(word, burstMs, lineMs, lineIndex, index);
            }, delay);
            wbwTimers.push(t);
        });
    }
}

function showSingleWord(word, burstMs, lineMs, lineIndex, wordIndex) {
    lyricsTarget.innerHTML = '';

    const lineWrapper = document.createElement('div');
    lineWrapper.className = 'lyric-line lyric-line--live';
    lineWrapper.style.animationDuration = `${lineMs}ms`;

    const span = document.createElement('span');
    span.className = 'lyric-word';
    span.textContent = word;
    span.style.animationDuration = `${burstMs}ms, 1800ms`;
    span.style.animationDelay = '0s, 0s';
    applyWordChaos(span, lineIndex, wordIndex);

    lineWrapper.appendChild(span);
    lyricsTarget.appendChild(lineWrapper);
}

function showBuildUp(words, revealedUpTo, burstMs, lineMs, lineIndex) {
    lyricsTarget.innerHTML = '';

    const lineWrapper = document.createElement('div');
    lineWrapper.className = 'lyric-line lyric-line--live';
    lineWrapper.style.animationDuration = `${lineMs}ms`;

    // Only render words up to revealedUpTo — no hidden placeholders.
    // justify-content: center on .lyric-line keeps the growing text centered.
    for (let index = 0; index <= revealedUpTo; index++) {
        const span = document.createElement('span');
        span.textContent = words[index];
        applyWordChaos(span, lineIndex, index);

        if (index < revealedUpTo) {
            // Already-revealed words: visible but dimmed, no animation
            span.className = 'lyric-word lyric-word--revealed';
        } else {
            // The newest word: full burst animation
            span.className = 'lyric-word';
            span.style.animationDuration = `${burstMs}ms, 1800ms`;
            span.style.animationDelay = '0s, 0s';
        }

        lineWrapper.appendChild(span);
    }

    lyricsTarget.appendChild(lineWrapper);
}

function renderLoop() {
    if (cachedLyrics?.length && lastPlayerState) {
        renderTimestamps(getInterpolatedPlaybackMs());
    }
    requestAnimationFrame(renderLoop);
}

function schedulePearPolling() {
    if (pearPollTimer) clearInterval(pearPollTimer);
    const ms = pearWsConnected ? API_POLL_WS_MS : API_POLL_MS;
    pearPollTimer = setInterval(pollPearAPI, ms);
    pollPearAPI();
}

renderLoop();
connectPearWebSocket();
schedulePearPolling();