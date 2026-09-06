import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { net } from 'electron';
import { USER_AGENT } from './metadata';

// Helpers shared by the app-managed external tools (yt-dlp, uv): locating
// executables, running them with a timeout, and downloading release assets
// with progress. Apps launched from Finder inherit a bare PATH, so the usual
// user-tool directories are probed explicitly.

export const EXTRA_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.cargo', 'bin'),
];

export function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function augmentedPath(): string {
  const parts = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  for (const d of EXTRA_PATH_DIRS) if (!parts.includes(d)) parts.push(d);
  return parts.join(path.delimiter);
}

/** First directory on PATH (+ extras) containing an executable `name`. */
export function findOnPath(name: string): string | null {
  for (const dir of augmentedPath().split(path.delimiter)) {
    const p = path.join(dir, name);
    if (isExecutable(p)) return p;
  }
  return null;
}

export function run(
  exe: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      args,
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, ...env, PATH: augmentedPath() },
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = err.killed
            ? `timed out after ${Math.round(timeoutMs / 1000)}s`
            : lastLine(stderr) || err.message;
          reject(new Error(detail));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export function lastLine(s: string): string {
  const lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines[lines.length - 1] ?? '').replace(/^(ERROR|error):\s*/, '');
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}

/** Stream a URL to disk; `onProgress(percent, got, total)` fires on each percent step. */
export async function downloadFile(
  url: string,
  dest: string,
  timeoutMs: number,
  onProgress: (percent: number, got: number, total: number) => void,
): Promise<void> {
  const res = await net.fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  let lastPct = -1;
  const counter = new Transform({
    transform: (chunk: Buffer, _enc, cb) => {
      got += chunk.length;
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (pct !== lastPct) {
        lastPct = pct;
        onProgress(pct, got, total);
      }
      cb(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
    counter,
    fs.createWriteStream(dest),
  );
}
