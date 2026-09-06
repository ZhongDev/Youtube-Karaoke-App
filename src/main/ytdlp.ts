import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { app, net } from 'electron';
import type { InstallProgress, SearchResult, YtDlpStatus } from '../shared/ipc';
import { parseSearchJson } from '../shared/ytSearch';
import { USER_AGENT } from './metadata';
import type { SettingsStore } from './settings';

// yt-dlp is the search backend (SPEC.md §7): no API key, and when YouTube
// changes something it is yt-dlp that gets fixed, not this app.
//
// Resolution order: settings override → the app's managed copy → PATH.
// Apps launched from Finder inherit a bare PATH, so the Homebrew directories
// are probed explicitly. The managed copy is the official `yt-dlp_macos.zip`
// (an *unpacked* PyInstaller build) unzipped into userData: the single-file
// `yt-dlp_macos` re-extracts itself on every launch (~5 s per search, measured),
// while the unpacked build starts in ~0.2 s after a one-time ~5 s first launch.

const RELEASE_ZIP =
  'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos.zip';
const MANAGED_EXE = 'yt-dlp_macos';
const SEARCH_LIMIT = 10;
const SEARCH_TIMEOUT_MS = 30_000;
/** First launch of a fresh build validates ~120 MB of dylibs — a few seconds. */
const VERSION_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const CACHE_TTL_MS = 10 * 60_000;
const EXTRA_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local', 'bin'),
];

export class YtDlpMissingError extends Error {
  constructor() {
    super('yt-dlp is not installed');
    this.name = 'YtDlpMissingError';
  }
}

interface Located {
  path: string;
  origin: 'settings' | 'managed' | 'path';
}

export class YtDlp {
  readonly managedDir: string;
  private versions = new Map<string, string>();
  private searchCache = new Map<string, { at: number; results: SearchResult[] }>();
  private installing: Promise<YtDlpStatus> | null = null;

  constructor(
    private settings: SettingsStore,
    private progress: (p: InstallProgress) => void,
  ) {
    this.managedDir = path.join(app.getPath('userData'), 'yt-dlp');
  }

  private get managedExe(): string {
    return path.join(this.managedDir, 'current', MANAGED_EXE);
  }

  locate(): Located | null {
    const custom = this.settings.get().ytdlp.path.trim();
    if (custom && isExecutable(custom)) return { path: custom, origin: 'settings' };
    if (isExecutable(this.managedExe)) return { path: this.managedExe, origin: 'managed' };
    const dirs = [...(process.env['PATH'] ?? '').split(path.delimiter), ...EXTRA_PATH_DIRS];
    for (const dir of dirs) {
      if (!dir) continue;
      const p = path.join(dir, 'yt-dlp');
      if (isExecutable(p)) return { path: p, origin: 'path' };
    }
    return null;
  }

  async status(): Promise<YtDlpStatus> {
    const custom = this.settings.get().ytdlp.path.trim();
    const customError =
      custom && !isExecutable(custom) ? `Configured yt-dlp path is not executable: ${custom}` : null;
    const base = { managedDir: this.managedDir };
    const loc = this.locate();
    if (!loc) {
      return {
        ...base,
        available: false,
        path: null,
        version: null,
        origin: null,
        error: customError ?? 'yt-dlp not found',
      };
    }
    try {
      const version = await this.version(loc.path);
      return { ...base, available: true, path: loc.path, version, origin: loc.origin, error: customError };
    } catch (err) {
      return {
        ...base,
        available: false,
        path: loc.path,
        version: null,
        origin: loc.origin,
        error: `${loc.path} failed to run: ${message(err)}`,
      };
    }
  }

  private async version(exe: string): Promise<string> {
    const cached = this.versions.get(exe);
    if (cached) return cached;
    const { stdout } = await run(exe, ['--version', '--ignore-config'], VERSION_TIMEOUT_MS);
    const v = stdout.trim().split('\n').pop() ?? '';
    if (!/^\d{4}\.\d{2}\.\d{2}/.test(v)) {
      throw new Error(`unexpected --version output: ${v.slice(0, 80)}`);
    }
    this.versions.set(exe, v);
    return v;
  }

  /** `ytsearch10:<query>` as flat JSON. Results are cached briefly per query. */
  async search(query: string): Promise<SearchResult[]> {
    const q = query.trim();
    const hit = this.searchCache.get(q);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.results;
    const loc = this.locate();
    if (!loc) throw new YtDlpMissingError();

    const t0 = Date.now();
    const { stdout, stderr } = await run(
      loc.path,
      [
        `ytsearch${SEARCH_LIMIT}:${q}`,
        '-J',
        '--flat-playlist',
        '--no-warnings',
        '--ignore-config',
        '--socket-timeout',
        '15',
      ],
      SEARCH_TIMEOUT_MS,
    );
    const results = parseSearchJson(stdout);
    const note = stderr.trim() ? ` (stderr: ${lastLine(stderr)})` : '';
    console.log(`[ytdlp] "${q}" → ${results.length} results in ${Date.now() - t0} ms${note}`);
    this.searchCache.set(q, { at: Date.now(), results });
    return results;
  }

  /** Download + unpack the latest release into userData (one at a time). */
  install(): Promise<YtDlpStatus> {
    if (!this.installing) {
      this.installing = this.doInstall().finally(() => {
        this.installing = null;
      });
    }
    return this.installing;
  }

  private async doInstall(): Promise<YtDlpStatus> {
    const stamp = Date.now();
    const zipPath = path.join(this.managedDir, `download-${stamp}.zip`);
    const unpackDir = path.join(this.managedDir, `unpack-${stamp}`);
    const currentDir = path.join(this.managedDir, 'current');
    try {
      await fs.promises.mkdir(this.managedDir, { recursive: true });
      this.report('download', 0, 'Downloading yt-dlp…');
      await this.download(RELEASE_ZIP, zipPath);

      this.report('unpack', 0, 'Unpacking…');
      await fs.promises.mkdir(unpackDir, { recursive: true });
      await unzip(zipPath, unpackDir);
      const exe = path.join(unpackDir, MANAGED_EXE);
      if (!fs.existsSync(exe)) throw new Error(`${MANAGED_EXE} missing from the archive`);
      await fs.promises.chmod(exe, 0o755);

      this.report('verify', 0, 'Verifying (the first launch takes a few seconds)…');
      const { stdout } = await run(exe, ['--version', '--ignore-config'], VERSION_TIMEOUT_MS);
      const version = stdout.trim().split('\n').pop() ?? '';
      if (!/^\d{4}\.\d{2}\.\d{2}/.test(version)) {
        throw new Error(`downloaded yt-dlp did not report a version (${version.slice(0, 80)})`);
      }

      await fs.promises.rm(currentDir, { recursive: true, force: true });
      await fs.promises.rename(unpackDir, currentDir);
      this.versions.set(this.managedExe, version);
      this.searchCache.clear();
      console.log(`[ytdlp] installed ${version} → ${this.managedExe}`);
      this.report('done', 100, `yt-dlp ${version} installed`);
      return this.status();
    } catch (err) {
      console.warn('[ytdlp] install failed:', err);
      this.report('error', 0, message(err));
      throw new Error(`yt-dlp download failed: ${message(err)}`);
    } finally {
      await fs.promises.rm(zipPath, { force: true });
      await fs.promises.rm(unpackDir, { recursive: true, force: true });
    }
  }

  private async download(url: string, dest: string): Promise<void> {
    const res = await net.fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
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
          const size = total ? `${mb(got)} / ${mb(total)} MB` : `${mb(got)} MB`;
          this.report('download', pct, `Downloading yt-dlp… ${size}`);
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

  private report(phase: InstallProgress['phase'], percent: number, msg: string): void {
    this.progress({ phase, percent, message: msg });
  }
}

// ── helpers ──

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function augmentedPath(): string {
  const parts = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  for (const d of EXTRA_PATH_DIRS) if (!parts.includes(d)) parts.push(d);
  return parts.join(path.delimiter);
}

function run(
  exe: string,
  args: string[],
  timeoutMs: number,
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
        env: { ...process.env, PATH: augmentedPath() },
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

async function unzip(zip: string, dest: string): Promise<void> {
  // macOS ships ditto (keeps executable bits and the Python.framework symlinks).
  if (isExecutable('/usr/bin/ditto')) {
    await run('/usr/bin/ditto', ['-x', '-k', zip, dest], 120_000);
    return;
  }
  await run('unzip', ['-q', '-o', zip, '-d', dest], 120_000);
}

function lastLine(s: string): string {
  const lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines[lines.length - 1] ?? '').replace(/^ERROR:\s*/, '');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}
