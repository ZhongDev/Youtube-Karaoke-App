import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { app } from 'electron';
import { referenceText } from '../shared/alignText';
import {
  estimateOffset,
  formatOffset,
  MAX_PLAUSIBLE_OFFSET_MS,
  offsetProbe,
  type HeardLine,
  type OffsetProbe,
} from '../shared/autoOffset';
import type { AlignJob, AlignKind, AlignSnapshot, AlignStage } from '../shared/ipc';
import { detectTrackLanguage } from '../shared/language';
import { parseLrc } from '../shared/lrc';
import type { Repo } from './repo';
import type { SettingsStore } from './settings';
import { augmentedPath, errorMessage } from './tools';
import type { Uv } from './uv';
import type { YtDlp } from './ytdlp';

// Tier-3 job queue (SPEC.md §5, Phase 5 + 6): one worker job at a time (it
// is CPU/GPU heavy), entirely in the background — playback never waits on
// it. Each job spawns worker/align.py once with a JSON payload on stdin;
// progress streams back as NDJSON. Three job kinds share the pipeline:
//   align      known text → source 'aligned' (synced_word), best-by-rank active
//   transcribe no text → source 'transcribed' (synced_word), pinned active
//   offset     first lines found in a transcription of the opening audio →
//              per-video offset applied

const BROADCAST_MIN_MS = 150;
const KILL_GRACE_MS = 3000;

interface WorkerEvent {
  event: 'progress' | 'result';
  stage?: string;
  percent?: number;
  message?: string;
  ok?: boolean;
  enhancedLrc?: string;
  /** transcribe: Whisper's detected language code. */
  language?: string | null;
  /** offset: what Whisper heard in the probe window, segment by segment. */
  heard?: HeardLine[];
  /** offset: first sustained vocal energy, the fallback anchor. */
  energyOnsetS?: number | null;
  error?: string;
  warnings?: string[];
}

const WORKER_STAGES: readonly AlignStage[] = [
  'download',
  'decode',
  'separate',
  'load',
  'align',
  'transcribe',
];

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

  /**
   * Queue a job. `source` names the lyrics to use: required for 'align',
   * optional for 'offset' (defaults to the active lyrics), ignored for
   * 'transcribe'. Validation happens here so the renderer gets an error
   * straight away rather than a failed job.
   */
  start(videoId: string, kind: AlignKind, source: string | null): AlignSnapshot {
    const row = this.repo.getTrack(videoId);
    if (!row) throw new Error('Unknown video — play or queue it first');
    const existing = this.jobs.get(videoId);
    if (existing && isAlignActive(existing.stage)) throw new Error('A job is already running for this video');

    let src = '';
    if (kind === 'align') {
      if (!source) throw new Error('Pick the lyrics to align');
      const doc = this.repo.getLyrics(videoId).find((d) => d.source === source);
      if (!doc) throw new Error(`No "${source}" lyrics stored for this video`);
      if (!referenceText(doc.body)) throw new Error('That source has no lyric text to align');
      src = source;
    } else if (kind === 'offset') {
      const doc = source
        ? this.repo.getLyrics(videoId).find((d) => d.source === source)
        : this.repo.activeLyrics(videoId);
      if (!doc) throw new Error('No lyrics to estimate an offset for');
      if (doc.kind === 'plain') throw new Error('Auto-offset needs time-synced lyrics');
      if (!offsetProbe(parseLrc(doc.body)?.lines ?? [])) {
        throw new Error('The lyrics have no sung lines to align');
      }
      src = doc.source;
    }

    const job: AlignJob = {
      videoId,
      kind,
      title: row.artist && row.track ? `${row.artist} — ${row.track}` : row.title || videoId,
      source: src,
      model: this.settings.get().align.model,
      stage: 'queued',
      percent: 0,
      message: this.running ? 'Waiting for the current job…' : 'Starting…',
      error: null,
      warnings: [],
      offsetMs: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    this.jobs.set(videoId, job);
    this.pending.push(videoId);
    console.log(`[align] queued ${kind} ${videoId}${src ? ` from "${src}"` : ''} (${job.model})`);
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
    if (!row) throw new Error('The video is gone');
    const doc =
      job.kind === 'transcribe'
        ? null
        : this.repo.getLyrics(videoId).find((d) => d.source === job.source);
    if (job.kind !== 'transcribe' && !doc) throw new Error('The reference lyrics are gone');

    let text = '';
    let probe: OffsetProbe | null = null;
    if (job.kind === 'align') {
      text = referenceText(doc!.body);
    } else if (job.kind === 'offset') {
      probe = offsetProbe(parseLrc(doc!.body)?.lines ?? []);
      if (!probe) throw new Error('The lyrics have no sung lines to align');
      text = probe.text;
    }

    const workDir = path.join(app.getPath('temp'), 'karaoke-align', videoId);
    await fs.promises.mkdir(workDir, { recursive: true });
    const payload = {
      videoId,
      mode: job.kind,
      text,
      language: row.language && row.language !== 'other' ? row.language : null,
      model: job.model,
      device: this.settings.get().align.device,
      ytdlp: ytdlp.path,
      workDir,
      /** offset: only the opening stretch of the video is decoded. */
      maxSeconds: probe?.windowS ?? null,
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
    if (!result.ok) throw new Error(result.error ?? 'worker returned no result');
    await fs.promises.rm(workDir, { recursive: true, force: true });
    job.warnings = result.warnings ?? [];
    const secs = Math.round((Date.now() - t0) / 1000);
    const dur = row.duration_s ?? undefined;

    if (job.kind === 'align') {
      if (!result.enhancedLrc) throw new Error('worker returned no lyrics');
      this.repo.upsertLyrics(videoId, 'aligned', 'synced_word', result.enhancedLrc, dur);
      // Back to best-by-rank so the new word-synced document is what plays.
      this.repo.setActiveSource(videoId, null);
      console.log(`[align] ${videoId} stored word-synced lyrics in ${secs} s${warnNote(job)}`);
      this.finish(job, 'done', `Word-synced lyrics ready (${job.model})`);
    } else if (job.kind === 'transcribe') {
      if (!result.enhancedLrc) throw new Error('worker returned no lyrics');
      this.repo.upsertLyrics(videoId, 'transcribed', 'synced_word', result.enhancedLrc, dur);
      // The user asked for this text explicitly: make it the active document
      // (best-by-rank would put it below any real lyrics that exist).
      this.repo.setActiveSource(videoId, 'transcribed');
      this.repo.setLanguage(videoId, detectTrackLanguage(row.title ?? '', result.enhancedLrc));
      console.log(`[align] ${videoId} stored transcription in ${secs} s${warnNote(job)}`);
      this.finish(
        job,
        'done',
        `Transcribed lyrics ready (${job.model}${result.language ? `, ${result.language}` : ''})`,
      );
    } else {
      const heard = result.heard ?? [];
      console.log(
        `[align] ${videoId} heard: ${heard.map((h) => `${h.startS.toFixed(1)}s "${h.text}"`).join(' | ')}`,
      );
      const est = estimateOffset(probe!, heard, result.energyOnsetS ?? null);
      if (!est) throw new Error(`No vocals found in the first ${probe!.windowS} s of the video`);
      if (Math.abs(est.offsetMs) > MAX_PLAUSIBLE_OFFSET_MS) {
        throw new Error(
          `Implausible result (${formatOffset(est.offsetMs)}) — the lyrics may not match this video; offset not changed`,
        );
      }
      if (est.note) job.warnings.push(est.note);
      this.repo.setOffset(videoId, est.offsetMs);
      job.offsetMs = est.offsetMs;
      const how = est.linesUsed
        ? `${est.linesUsed} of ${probe!.lineCount} lines recognised (spread ${(est.spreadMs / 1000).toFixed(1)} s` +
          (est.outliers ? `, ${est.outliers} stray match ignored)` : ')')
        : 'from the first vocal sound';
      console.log(`[align] ${videoId} auto-offset ${formatOffset(est.offsetMs)} in ${secs} s, ${how}${warnNote(job)}`);
      this.finish(job, 'done', `Offset ${formatOffset(est.offsetMs)} applied — ${how}`);
    }
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

function warnNote(job: AlignJob): string {
  return job.warnings.length ? ` (warnings: ${job.warnings.join(' / ')})` : '';
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
