import type { QueueAddMode, QueueItem, QueueLyricsState, QueueSnapshot } from '../shared/ipc';
import { insertIndexFor, moveItem, moveToFront } from '../shared/queueLogic';
import { extractVideoId } from '../shared/youtubeUrl';
import type { LyricsService } from './lyricsService';
import type { Repo, QueueRow } from './repo';

// Persisted queue (SPEC.md §7, Phase 2). The main process owns the queue;
// the renderer only sends mutations and receives full snapshots via `send`.
// items[0] is now playing — see shared/queueLogic.ts for the model.
//
// Adding a song kicks off a metadata + lyrics prefetch through the regular
// LyricsService (cache-first, so a known song costs no network) so the
// per-item badge is meaningful before the song comes up. Prefetches run one
// at a time to stay a polite LRCLIB client when a batch of URLs is pasted.

export class QueueService {
  private rev = 0;
  /** Transient per-video state not derivable from the DB. */
  private status = new Map<string, 'fetching' | 'error'>();
  private pending: string[] = [];
  private working = false;

  constructor(
    private repo: Repo,
    private lyrics: LyricsService,
    private send: (snapshot: QueueSnapshot) => void,
  ) {}

  /** Call once at startup: resume metadata fetches that never landed. */
  init(): void {
    for (const row of this.repo.listQueue()) {
      if (row.title === null) this.prefetch(row.video_id);
    }
  }

  snapshot(): QueueSnapshot {
    return { rev: this.rev, items: this.repo.listQueue().map((r) => this.toItem(r)) };
  }

  add(input: string, mode: QueueAddMode): number {
    const videoId = extractVideoId(input);
    if (!videoId) throw new Error('Not a YouTube URL or video id');
    const index = insertIndexFor(this.repo.queueIds().length, mode);
    const id = this.repo.insertQueueItem(videoId, index);
    console.log(`[queue] add ${videoId} as #${id} at ${index} (${mode})`);
    this.broadcast();
    this.prefetch(videoId);
    return id;
  }

  remove(id: number): void {
    console.log(`[queue] remove #${id}`);
    this.repo.deleteQueueItem(id);
    this.broadcast();
  }

  move(id: number, toIndex: number): void {
    const ids = this.repo.queueIds();
    const next = moveItem(ids, id, toIndex);
    console.log(`[queue] move #${id} → ${toIndex}: [${ids}] → [${next}]`);
    if (next !== ids) this.repo.setQueueOrder(next);
    this.broadcast();
  }

  play(id: number): void {
    const ids = this.repo.queueIds();
    const next = moveToFront(ids, id);
    console.log(`[queue] play #${id}: [${ids}] → [${next}]`);
    if (next !== ids) this.repo.setQueueOrder(next);
    this.broadcast();
  }

  advance(): void {
    const head = this.repo.queueIds()[0];
    console.log(`[queue] advance (drop #${head ?? 'none'})`);
    if (head !== undefined) this.repo.deleteQueueItem(head);
    this.broadcast();
  }

  clear(): void {
    console.log('[queue] clear');
    this.repo.clearQueue();
    this.pending = [];
    this.broadcast();
  }

  /** Re-send a snapshot after lyrics/metadata changed outside this service. */
  refresh(videoId?: string): void {
    if (videoId) this.status.delete(videoId);
    this.broadcast();
  }

  private prefetch(videoId: string): void {
    if (this.status.get(videoId) === 'fetching') return;
    this.status.set(videoId, 'fetching');
    this.pending.push(videoId);
    this.broadcast();
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      let videoId: string | undefined;
      while ((videoId = this.pending.shift()) !== undefined) {
        try {
          await this.lyrics.resolve(videoId);
          this.status.delete(videoId);
        } catch (err) {
          console.warn(`[queue] prefetch failed for ${videoId}:`, err);
          this.status.set(videoId, 'error');
        }
        this.broadcast();
      }
    } finally {
      this.working = false;
    }
  }

  private broadcast(): void {
    this.rev++;
    this.send(this.snapshot());
  }

  private toItem(r: QueueRow): QueueItem {
    return {
      id: r.id,
      videoId: r.video_id,
      title: r.title ?? '',
      channel: r.channel ?? '',
      artist: r.artist,
      track: r.track,
      durationS: r.duration_s,
      isTopic: r.is_topic === 1,
      embeddable: r.embeddable !== 0,
      lyrics: this.lyricsState(r),
    };
  }

  private lyricsState(r: QueueRow): QueueLyricsState {
    const transient = this.status.get(r.video_id);
    if (transient) return transient;
    return r.best_kind ?? 'none';
  }
}
