const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Settings the main process needs before the app is ready (GPU switches
// can't be changed after launch), so they live in a file, not localStorage.
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// GPU acceleration: on by default. Rasterize on the GPU and skip Chromium's
// driver blocklist so the blurred background, lyric animations and the
// visualizer canvas stay on the GPU even on drivers Chromium is wary of.
// Turning it off falls back to software rendering, for setups where a
// driver misbehaves.
const settings = loadSettings();
const gpuAcceleration = settings.gpuAcceleration !== false;
if (gpuAcceleration) {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
} else {
  app.disableHardwareAcceleration();
}

// VSync: on by default (Chromium's normal behavior) — frames are presented in
// step with the display's refresh, so animations never tear. Turning it off
// uncaps the frame rate, for benchmarking or high-refresh setups that want
// every frame they can get.
const vsync = settings.vsync !== false;
if (!vsync) {
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('disable-frame-rate-limit');
}

const RENDER_SETTINGS = ['gpuAcceleration', 'vsync'];

// getGPUFeatureStatus() reports software rendering until the GPU process has
// started and sent its info, so wait for that (with a timeout, in case the
// GPU process never comes up) instead of showing a false "GPU unavailable".
const gpuInfoReady = gpuAcceleration
  ? new Promise((resolve) => {
    app.once('gpu-info-update', resolve);
    setTimeout(resolve, 5000);
  })
  : Promise.resolve();

ipcMain.handle('render:get-status', async () => {
  await gpuInfoReady;
  return { gpuAcceleration, vsync, features: app.getGPUFeatureStatus() };
});

ipcMain.handle('render:set', (event, key, enabled, restartNow) => {
  if (!RENDER_SETTINGS.includes(key)) return;
  saveSettings({ ...loadSettings(), [key]: Boolean(enabled) });
  if (restartNow) {
    app.relaunch();
    app.exit(0);
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 600,
    minWidth: 640,
    minHeight: 400,
    autoHideMenuBar: true,
    frame: true,
    backgroundColor: '#0b0b0f',
    // Linux takes the window/taskbar icon from here; macOS and Windows use
    // the app bundle's.
    ...(process.platform === 'linux' ? { icon: path.join(__dirname, 'icon.png') } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

// Uptempo mode's "System Audio" source goes through getDisplayMedia. Hand it
// loopback audio (what's playing on the machine) without showing a picker.
// The video half is just this window's own page — the renderer drops it right
// away, and capturing our own frame instead of the screen avoids the macOS
// Screen Recording prompt. Loopback works on Windows, and on macOS 14.2+
// through Apple's CoreAudio Tap (Electron 39+, needs the
// NSAudioCaptureUsageDescription key from macos-info.plist).
function handleDisplayMediaRequests() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (request.frame) {
      callback({ video: request.frame, audio: 'loopback' });
      return;
    }
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
      .catch(() => callback(null));
  });
}

// Uptempo mode's "System Audio" on Linux. Chromium refuses to open
// PulseAudio "monitor" sources (what the speakers are playing), so remap the
// default output's monitor into an ordinary input it will open. Works on
// PulseAudio and on PipeWire through pipewire-pulse with `pactl`; on PipeWire
// systems without `pactl`, falls back to PipeWire's own `pw-loopback`.
const LINUX_AUDIO_SOURCE_NAME = 'pearlyrics_system_audio';
// No spaces: pipewire-pulse cuts quoted module arguments at the first space.
const LINUX_AUDIO_SOURCE_LABEL = 'PearLyrics-System-Audio';
let linuxAudioModule = null;
let linuxAudioSink = null;
let linuxAudioLoopback = null; // pw-loopback process, when pactl is missing

function pactl(args) {
  return new Promise((resolve, reject) => {
    execFile('pactl', args, { env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

async function unloadLinuxSystemAudio() {
  // Also clears a source left behind by a crashed earlier run.
  const modules = await pactl(['list', 'short', 'modules']).catch(() => '');
  const ids = modules.split('\n')
    .filter((line) => line.includes(`source_name=${LINUX_AUDIO_SOURCE_NAME}`))
    .map((line) => line.split('\t')[0]);
  await Promise.all(ids.map((id) => pactl(['unload-module', id]).catch(() => {})));
  linuxAudioModule = null;
  linuxAudioSink = null;
}

async function enableLinuxSystemAudio() {
  const info = await pactl(['info']);
  const sink = info.match(/^Default Sink:\s*(.+)$/m)?.[1]?.trim();
  if (!sink) throw new Error('no default audio output found');
  // Follow the default output if it changed (e.g. headphones plugged in).
  if (linuxAudioModule && linuxAudioSink === sink) return LINUX_AUDIO_SOURCE_LABEL;
  await unloadLinuxSystemAudio();
  linuxAudioModule = await pactl([
    'load-module', 'module-remap-source',
    `master=${sink}.monitor`,
    `source_name=${LINUX_AUDIO_SOURCE_NAME}`,
    `source_properties=device.description=${LINUX_AUDIO_SOURCE_LABEL}`,
  ]);
  linuxAudioSink = sink;
  return LINUX_AUDIO_SOURCE_LABEL;
}

// PipeWire without pactl: pw-loopback captures the default output (and
// follows it when it changes) and plays it into a virtual input. It runs
// for as long as the source should exist, so it's killed on quit.
function enableLinuxSystemAudioPipeWire() {
  if (linuxAudioLoopback) return Promise.resolve(LINUX_AUDIO_SOURCE_LABEL);
  return new Promise((resolve, reject) => {
    const child = spawn('pw-loopback', [
      '--name', 'pearlyrics',
      '--capture-props', 'stream.capture.sink=true',
      // Audio/Source, not Audio/Source/Virtual: Chromium lists a virtual
      // source but hangs opening it.
      '--playback-props', `media.class=Audio/Source node.name=${LINUX_AUDIO_SOURCE_NAME} node.description=${LINUX_AUDIO_SOURCE_LABEL}`,
    ], { stdio: 'ignore' });
    child.once('error', (err) => {
      reject(err.code === 'ENOENT' ? new Error('pactl or pw-loopback not found — install PulseAudio or PipeWire') : err);
    });
    child.once('spawn', () => {
      linuxAudioLoopback = child;
      resolve(LINUX_AUDIO_SOURCE_LABEL);
    });
    child.once('exit', () => {
      if (linuxAudioLoopback === child) linuxAudioLoopback = null;
    });
  });
}

ipcMain.handle('audio:enable-linux-system-audio', () => enableLinuxSystemAudio().catch((err) => {
  if (err.code !== 'ENOENT') throw err;
  return enableLinuxSystemAudioPipeWire();
}));

app.on('will-quit', (event) => {
  linuxAudioLoopback?.kill();
  if (process.platform !== 'linux' || !linuxAudioModule) return;
  event.preventDefault();
  unloadLinuxSystemAudio().finally(() => app.quit());
});

app.whenReady().then(() => {
  handleDisplayMediaRequests();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
