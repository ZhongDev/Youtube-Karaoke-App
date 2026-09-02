// Shared IPC contract between main, preload and renderer.
// Every channel gets: a constant, a typed request/response, and a method on KaraokeApi.
// No `any` crosses this boundary (SPEC.md §11).

export interface AppInfo {
  appVersion: string;
  dbPath: string;
  schemaVersion: number;
}

export const IPC = {
  getAppInfo: 'app:get-info',
} as const;

/** The API exposed on `window.karaoke` by the preload script. */
export interface KaraokeApi {
  getAppInfo(): Promise<AppInfo>;
}

declare global {
  interface Window {
    karaoke: KaraokeApi;
  }
}
