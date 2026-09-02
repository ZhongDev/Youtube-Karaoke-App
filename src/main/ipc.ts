import { app, ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { IPC, type AppInfo } from '../shared/ipc';
import { schemaVersion } from './db';

export function registerIpcHandlers(db: Database.Database, dbPath: string): void {
  ipcMain.handle(IPC.getAppInfo, (): AppInfo => ({
    appVersion: app.getVersion(),
    dbPath,
    schemaVersion: schemaVersion(db),
  }));
}
