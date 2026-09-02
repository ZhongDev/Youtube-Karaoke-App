import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { getDbPath, openDatabase } from './db';
import { registerIpcHandlers } from './ipc';
import { APP_HOST, APP_SCHEME, registerAppScheme, serveRenderer } from './protocol';

if (started) {
  app.quit();
}

// Must happen before app ready.
registerAppScheme();

const createWindow = () => {
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

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/`);
  }
};

app.whenReady().then(() => {
  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    serveRenderer(MAIN_WINDOW_VITE_NAME);
  }

  const dbPath = getDbPath();
  const db = openDatabase(dbPath);
  registerIpcHandlers(db, dbPath);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
