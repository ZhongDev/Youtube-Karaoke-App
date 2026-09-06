import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { app } from 'electron';
import { referenceText } from '../shared/alignText';
import type { AlignJob, AlignSnapshot, AlignStage } from '../shared/ipc';
import type { Repo } from './repo';
import type { SettingsStore } from './settings';
import { augmentedPath, errorMessage } from './tools';
import type { Uv } from './uv';
import type { YtDlp } from './ytdlp';

// Tier-3 job queue (SPEC.md §5, Phase 5): one forced alignment at a time
// (it is CPU/GPU heavy), entirely in the background — playback never waits
// on it. Each job spawns worker/align.py once with the reference text on
// stdin; progress streams back as NDJSON and the result is stored as source
// 'aligned' / kind synced_word, which best-by-rank then makes active.

const BROADCAST_MIN_MS = 150;
const KILL_GRACE_MS = 3000;

interface WorkerEvent {
  event: 'progress' | 'result';
  stage?: string;
  percent?: number;
  message?: string;
  ok?: boolean;
  enhancedLrc?: string;
  error?: string;
  warnings?: string[];
}

const WORKER_STAGES: readonly AlignStage[] = ['download', 'decode', 'separate', 'load', 'align'];

export function isAlignActive(stage: AlignStage): boolean {
  return stage !== 'done' && stage !== 'error' && stage !== 'cancelled';
}

export class AlignService {
  private jobs = new Map<string, AlignJob>();
  private pending: string[] = [];
  private running: { videoId: string; child: ChildProcess | null; cancelled: boolean } | null =
    null;
  private lastSent = 0;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private repo: Repo,
    private settings: SettingsStore,
    private uv: Uv,
    private ytdlp: YtDlp,
    private send: (snapshot: AlignSnapshot) => void,
    private onStored: (videoId: string) => void,
  ) {}

  snapshot(): AlignSnapshot {
    return { jobs: [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt) };
  }

  start(videoId: string, source: string): AlignSnapshot {
    const row = this.repo.getTrack(videoId);
    if (!row) throw new Error('Unknown video — play or queue it first');
    const doc = this.repo.getLyrics(videoId).find((d) => d.source === source);
    if (!doc) throw new Error(`No "${source}" lyrics stored for this video`);
    if (!referenceText(doc.body)) throw new Error('That source has no lyric text to align');
    const existing = this.jobs.get(videoId);
    if (existing && isAlignActive(existing.stage)) throw new Error('Already aligning this video');

    const job: AlignJob = {
      videoId,
      title: row.artist && row.track ? `${row.artist} — ${row.track}` : row.title || videoId,
      source,
      model: this.settings.get().align.model,
      stage: 'queued',
      percent: 0,
      message: this.running ? 'Waiting for the current job…' : 'Starting…',
      error: null,
      warnings: [],
      startedAt: Date.now(),
      finishedAt: null,
    };
    this.jobs.set(videoId, job);
    this.pending.push(videoId);
    console.log(`[align] queued ${videoId} from "${source}" (${job.model})`);
    this.broadcast(true);
    void this.drain();
    return this.snapshot();
  }

  cancel(videoId: string): AlignSnapshot {
    const job = this.jobs.get(videoId);
    if (!job) return this.snapshot();
    if (job.stage === 'queued') {
      this.pending = this.pending.filter((id) => id !== videoId);
      this.finish(job, 'cancelled', 'Cancelled');
    } else if (this.running?.videoId === videoId && !this.running.cancelled) {
      console.log(`[align] cancelling ${videoId}`);
      this.running.cancelled = true;
      this.update(job, job.stage, job.percent, 'Cancelling…');
      killTree(this.running.child);
    }
    return this.snapshot();
  }

  /** App quit: never leave a torch process behind. */
  shutdown(): void {
    if (this.running) {
      this.running.cancelled = true;
      killTree(this.running.child);
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    let videoId: string | undefined;
    while ((videoId = this.pending.shift()) !== undefined) {
      const job = this.jobs.get(videoId);
      if (!job || job.stage !== 'queued') continue;
      const slot = { videoId, child: null, cancelled: false };
      this.running = slot;
      try {
        await this.runJob(job);
      } catch (err) {
        if (slot.cancelled) {
          this.finish(job, 'cancelled', 'Cancelled');
        } else {
          console.warn(`[align] ${videoId} failed:`, errorMessage(err));
          this.finish(job, 'error', errorMessage(err));
        }
      } finally {
        this.running = null;
      }
    }
  }

  private async runJob(job: AlignJob): Promise<void> {
    const { videoId } = job;
    const slot = this.running!;

    this.update(job, 'setup', 0, 'Checking the Python environment…');
    if (!this.uv.locate()) {
      throw new Error('uv is not installed — set it up under Settings → Local alignment');
    }
    await this.uv.ensureEnv((msg) => this.update(job, 'setup', 0, msg));
    if (slot.cancelled) throw new Error('cancelled');
    const ytdlp = this.ytdlp.locate();
    if (!ytdlp) throw new Error('yt-dlp is not installed — set it up under Settings → Search');

    const row = this.repo.getTrack(videoId);
    const doc = this.repo.getLyrics(videoId).find((d) => d.source === job.source);
    if (!row || !doc) throw new Error('The reference lyrics are gone');

    const workDir = path.join(app.getPath('temp'), 'karaoke-align', videoId);
    await fs.promises.mkdir(workDir, { recursive: true });
    const payload = {
      videoId,
      text: referenceText(doc.body),
      language: row.language && row.language !== 'other' ? row.language : null,
      model: job.model,
      device: this.settings.get().align.device,
      ytdlp: ytdlp.path,
      workDir,
      keepAudio: false,
    };

    const t0 = Date.now();
    this.update(job, 'download', 0, 'Starting the worker…');
    const result = await new Promise<WorkerEvent>((resolve, reject) => {
      const child = spawn(this.uv.python, [path.join(this.uv.workerDir, 'align.py')], {
        cwd: this.uv.workerDir,
        env: {
          ...process.env,
          PATH: augmentedPath(),
          PYTORCH_ENABLE_MPS_FALLBACK: '1',
          PYTHONUNBUFFERED: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true, // own process group → killTree can take torch down too
      });
      slot.child = child;
      let final: WorkerEvent | null = null;
      let lastErr = '';

      readline.createInterface({ input: child.stdout! }).on('line', (line) => {
        let ev: WorkerEvent;
        try {
          ev = JSON.parse(line) as WorkerEvent;
        } catch {
          return;
        }
        if (ev.event === 'progress') {
          this.update(job, asStage(ev.stage), ev.percent ?? 0, ev.message ?? '');
        } else if (ev.event === 'result') {
          final = ev;
        }
      });
      readline.createInterface({ input: child.stderr! }).on('line', (line) => {
        // tqdm bars arrive as \r-separated fragments — keep the log readable.
        const l = line.split('\r').pop()?.trim() ?? '';
        if (!l || l.includes('%|')) return;
        lastErr = l;
        console.log(`[align:py] ${l.slice(0, 300)}`);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (final) resolve(final);
        else reject(new Error(`worker exited with code ${code}${lastErr ? `: ${lastErr}` : ''}`));
      });
      child.stdin!.end(JSON.stringify(payload));
    });

    if (slot.cancelled) throw new Error('cancelled');
    if (!result.ok || !result.enhancedLrc) throw new Error(result.error ?? 'worker returned no result');

    job.warnings = result.warnings ?? [];
    this.repo.upsertLyrics(videoId, 'aligned', 'synced_word', result.enhancedLrc, row.duration_s ?? undefined);
    // Back to best-by-rank so the new word-synced document is what plays.
    this.repo.setActiveSource(videoId, null);
    await fs.promises.rm(workDir, { recursive: true, force: true });
    console.log(
      `[align] ${videoId} stored word-synced lyrics in ${Math.round((Date.now() - t0) / 1000)} s` +
        (job.warnings.length ? ` (warnings: ${job.warnings.join(' / ')})` : ''),
    );
    this.finish(job, 'done', `Word-synced lyrics ready (${job.model})`);
    this.onStored(videoId);
  }

  private update(job: AlignJob, stage: AlignStage, percent: number, message: string): void {
    job.stage = stage;
    job.percent = Math.max(0, Math.min(100, percent));
    job.message = message;
    this.broadcast(false);
  }

  private finish(job: AlignJob, stage: 'done' | 'error' | 'cancelled', message: string): void {
    job.stage = stage;
    job.percent = stage === 'done' ? 100 : job.percent;
    job.message = message;
    job.error = stage === 'error' ? message : null;
    job.finishedAt = Date.now();
    this.broadcast(true);
  }

  /** Progress can arrive many times a second (yt-dlp) — coalesce pushes. */
  private broadcast(now: boolean): void {
    const due = this.lastSent + BROADCAST_MIN_MS - Date.now();
    if (now || due <= 0) {
      if (this.sendTimer) {
        clearTimeout(this.sendTimer);
        this.sendTimer = null;
      }
      this.lastSent = Date.now();
      this.send(this.snapshot());
      return;
    }
    if (!this.sendTimer) {
      this.sendTimer = setTimeout(() => {
        this.sendTimer = null;
        this.lastSent = Date.now();
        this.send(this.snapshot());
      }, due);
    }
  }
}

function asStage(s: string | undefined): AlignStage {
  return (WORKER_STAGES as readonly string[]).includes(s ?? '') ? (s as AlignStage) : 'align';
}

function killTree(child: ChildProcess | null): void {
  if (!child?.pid) return;
  const pid = child.pid;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, KILL_GRACE_MS).unref();
}
