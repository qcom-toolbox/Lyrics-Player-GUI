const { app, BrowserWindow, session, desktopCapturer } = require('electron');
const path = require('path');

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
