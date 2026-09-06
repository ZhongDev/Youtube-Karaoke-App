import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import type { InstallProgress, UvStatus } from '../shared/ipc';
import type { SettingsStore } from './settings';
import {
  augmentedPath,
  downloadFile,
  errorMessage,
  findOnPath,
  isExecutable,
  mb,
  run,
} from './tools';

// uv manages the alignment worker's Python (SPEC.md §2): it downloads a
// private CPython 3.12 and the torch/Demucs/Whisper stack from worker/uv.lock
// into a venv under userData, so nothing system-wide changes. Like yt-dlp,
// uv itself is resolved from settings → an app-managed copy (downloaded from
// the official GitHub release) → PATH.

const RELEASE_TARBALL = `https://github.com/astral-sh/uv/releases/latest/download/uv-${
  process.arch === 'arm64' ? 'aarch64' : 'x86_64'
}-apple-darwin.tar.gz`;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** First sync downloads CPython + ~600 MB of wheels. */
const SYNC_TIMEOUT_MS = 30 * 60_000;

interface Located {
  path: string;
  origin: 'settings' | 'managed' | 'path';
}

export class Uv {
  readonly managedDir: string;
  /** UV_PROJECT_ENVIRONMENT: the worker venv (outside the read-only app bundle). */
  readonly envDir: string;
  /** Directory holding pyproject.toml / uv.lock / align.py. */
  readonly workerDir: string;
  private versions = new Map<string, string>();
  private busy: Promise<UvStatus> | null = null;

  constructor(
    private settings: SettingsStore,
    private progress: (p: InstallProgress) => void,
  ) {
    this.managedDir = path.join(app.getPath('userData'), 'uv');
    this.envDir = path.join(app.getPath('userData'), 'align-venv');
    this.workerDir = app.isPackaged
      ? path.join(process.resourcesPath, 'worker')
      : path.join(app.getAppPath(), 'worker');
  }

  private get managedExe(): string {
    return path.join(this.managedDir, 'current', 'uv');
  }

  /** The venv's interpreter, for running the worker directly. */
  get python(): string {
    return path.join(this.envDir, 'bin', 'python');
  }

  locate(): Located | null {
    const custom = this.settings.get().uv.path.trim();
    if (custom && isExecutable(custom)) return { path: custom, origin: 'settings' };
    if (isExecutable(this.managedExe)) return { path: this.managedExe, origin: 'managed' };
    const onPath = findOnPath('uv');
    return onPath ? { path: onPath, origin: 'path' } : null;
  }

  /** Fast check: venv exists and was synced from the current uv.lock. */
  envReady(): boolean {
    try {
      return (
        isExecutable(this.python) &&
        fs.readFileSync(this.markerPath, 'utf8').trim() === this.lockHash()
      );
    } catch {
      return false;
    }
  }

  async status(): Promise<UvStatus> {
    const custom = this.settings.get().uv.path.trim();
    const customError =
      custom && !isExecutable(custom) ? `Configured uv path is not executable: ${custom}` : null;
    const base = { managedDir: this.managedDir, envDir: this.envDir, envReady: this.envReady() };
    const loc = this.locate();
    if (!loc) {
      return {
        ...base,
        available: false,
        path: null,
        version: null,
        origin: null,
        error: customError ?? 'uv not found',
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
        error: `${loc.path} failed to run: ${errorMessage(err)}`,
      };
    }
  }

  private async version(exe: string): Promise<string> {
    const cached = this.versions.get(exe);
    if (cached) return cached;
    const { stdout } = await run(exe, ['--version'], 20_000);
    const m = /^uv\s+(\S+)/.exec(stdout.trim());
    if (!m) throw new Error(`unexpected --version output: ${stdout.slice(0, 80)}`);
    this.versions.set(exe, m[1]!);
    return m[1]!;
  }

  /** Download + unpack the latest uv release into userData (one at a time). */
  install(): Promise<UvStatus> {
    return this.exclusive(() => this.doInstall());
  }

  /** `uv sync --frozen` the worker environment, reporting uv's own log lines. */
  prepareEnv(): Promise<UvStatus> {
    return this.exclusive(() => this.doPrepareEnv());
  }

  /** Make sure the env exists and matches the lock; sync when it doesn't. */
  async ensureEnv(onMessage: (msg: string) => void): Promise<void> {
    if (this.envReady()) return;
    const off = this.tap(onMessage);
    try {
      await this.prepareEnv();
    } finally {
      off();
    }
  }

  private exclusive(fn: () => Promise<UvStatus>): Promise<UvStatus> {
    if (this.busy) return this.busy.then(fn);
    const p = fn().finally(() => {
      if (this.busy === p) this.busy = null;
    });
    this.busy = p;
    return p;
  }

  private async doInstall(): Promise<UvStatus> {
    const stamp = Date.now();
    const tarPath = path.join(this.managedDir, `download-${stamp}.tar.gz`);
    const unpackDir = path.join(this.managedDir, `unpack-${stamp}`);
    const currentDir = path.join(this.managedDir, 'current');
    try {
      await fs.promises.mkdir(this.managedDir, { recursive: true });
      this.report('download', 0, 'Downloading uv…');
      await downloadFile(RELEASE_TARBALL, tarPath, DOWNLOAD_TIMEOUT_MS, (pct, got, total) => {
        const size = total ? `${mb(got)} / ${mb(total)} MB` : `${mb(got)} MB`;
        this.report('download', pct, `Downloading uv… ${size}`);
      });
      this.report('unpack', 0, 'Unpacking…');
      await fs.promises.mkdir(unpackDir, { recursive: true });
      await run('/usr/bin/tar', ['-xzf', tarPath, '-C', unpackDir, '--strip-components', '1'], 120_000);
      const exe = path.join(unpackDir, 'uv');
      if (!fs.existsSync(exe)) throw new Error('uv binary missing from the archive');
      await fs.promises.chmod(exe, 0o755);
      this.report('verify', 0, 'Verifying…');
      const version = await this.version(exe);
      await fs.promises.rm(currentDir, { recursive: true, force: true });
      await fs.promises.rename(unpackDir, currentDir);
      this.versions.set(this.managedExe, version);
      console.log(`[uv] installed ${version} → ${this.managedExe}`);
      this.report('done', 100, `uv ${version} installed`);
      return this.status();
    } catch (err) {
      console.warn('[uv] install failed:', err);
      this.report('error', 0, errorMessage(err));
      throw new Error(`uv download failed: ${errorMessage(err)}`);
    } finally {
      await fs.promises.rm(tarPath, { force: true });
      await fs.promises.rm(unpackDir, { recursive: true, force: true });
    }
  }

  private async doPrepareEnv(): Promise<UvStatus> {
    const loc = this.locate();
    if (!loc) throw new Error('uv is not installed');
    this.report('sync', 0, 'Preparing the Python environment (torch, Demucs, Whisper)…');
    const t0 = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          loc.path,
          ['sync', '--frozen', '--project', this.workerDir, '--no-progress', '--color', 'never'],
          {
            env: {
              ...process.env,
              PATH: augmentedPath(),
              UV_PROJECT_ENVIRONMENT: this.envDir,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('uv sync timed out'));
        }, SYNC_TIMEOUT_MS);
        let tail = '';
        const onLine = (line: string) => {
          const l = line.trim();
          if (!l) return;
          tail = l;
          console.log(`[uv] ${l}`);
          this.report('sync', 0, l.replace(/^\s*[+~-]\s*/, ''));
        };
        let buf = '';
        const onData = (d: Buffer) => {
          buf += d.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          lines.forEach(onLine);
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (buf.trim()) onLine(buf);
          if (code === 0) resolve();
          else reject(new Error(`uv sync exited with code ${code}: ${tail}`));
        });
      });
      await fs.promises.writeFile(this.markerPath, this.lockHash());
      console.log(`[uv] environment ready in ${Math.round((Date.now() - t0) / 1000)} s`);
      this.report('done', 100, 'Python environment ready');
      return this.status();
    } catch (err) {
      console.warn('[uv] sync failed:', err);
      this.report('error', 0, errorMessage(err));
      throw new Error(`Python environment setup failed: ${errorMessage(err)}`);
    }
  }

  private get markerPath(): string {
    return path.join(this.envDir, '.karaoke-synced');
  }

  private lockHash(): string {
    const lock = fs.readFileSync(path.join(this.workerDir, 'uv.lock'));
    return crypto.createHash('sha256').update(lock).digest('hex');
  }

  private listeners = new Set<(msg: string) => void>();

  private tap(fn: (msg: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private report(phase: InstallProgress['phase'], percent: number, message: string): void {
    this.progress({ phase, percent, message });
    for (const l of this.listeners) l(message);
  }
}
