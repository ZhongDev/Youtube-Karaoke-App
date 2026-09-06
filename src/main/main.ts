import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { IPC } from '../shared/ipc';
import { getDbPath, openDatabase } from './db';
import { registerIpcHandlers } from './ipc';
import { startRendererServer } from './server';

if (started) {
  app.quit();
}

// Dev affordance: point a second instance at its own data folder (DB, yt-dlp
// copy) so the real one is left untouched while testing.
const userDataOverride = process.env['KARAOKE_USER_DATA'];
if (userDataOverride) app.setPath('userData', userDataOverride);

const createWindow = (rendererUrl: string) => {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#0f1115',
    title: 'YouTube Karaoke',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // TV mode follows the window's fullscreen state, however it was entered
  // (our button/hotkey, the green traffic light, ⌃⌘F) — see window.ts.
  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send(IPC.fullscreenChanged, true);
  });
  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send(IPC.fullscreenChanged, false);
  });

  mainWindow.loadURL(rendererUrl);
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
};

app.whenReady().then(async () => {
  const rendererUrl =
    MAIN_WINDOW_VITE_DEV_SERVER_URL ||
    (await startRendererServer(MAIN_WINDOW_VITE_NAME));

  const dbPath = getDbPath();
  const db = openDatabase(dbPath);
  registerIpcHandlers(db, dbPath);

  createWindow(rendererUrl);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(rendererUrl);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
