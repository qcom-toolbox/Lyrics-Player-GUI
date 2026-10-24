const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
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
const gpuAcceleration = loadSettings().gpuAcceleration !== false;
if (gpuAcceleration) {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
} else {
  app.disableHardwareAcceleration();
}

ipcMain.handle('gpu:get-status', () => ({
  enabled: gpuAcceleration,
  features: app.getGPUFeatureStatus(),
}));

ipcMain.handle('gpu:set-enabled', (event, enabled, restartNow) => {
  saveSettings({ ...loadSettings(), gpuAcceleration: Boolean(enabled) });
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
