import type Database from 'better-sqlite3';
import type { LyricsDoc, LyricsKind, MetaSource, TrackInfo } from '../shared/ipc';
import { isLanguage, type Language } from '../shared/language';

export interface TrackRow {
  video_id: string;
  title: string | null;
  channel: string | null;
  artist: string | null;
  track: string | null;
  duration_s: number | null;
  is_topic: number;
  embeddable: number;
  language: string | null;
  /** User-pinned lyrics source; null = best by rank. */
  active_source: string | null;
  meta_source: string | null;
}

interface LyricsRow {
  source: string;
  kind: LyricsKind;
  body: string;
  provider_duration_s: number | null;
}

/** One queue row joined with its track and best lyrics kind (null = none). */
export interface QueueRow {
  id: number;
  video_id: string;
  title: string | null;
  channel: string | null;
  artist: string | null;
  track: string | null;
  duration_s: number | null;
  is_topic: number | null;
  embeddable: number | null;
  best_kind: LyricsKind | null;
}

const KIND_RANK: Record<LyricsKind, number> = {
  synced_word: 3,
  synced_line: 2,
  plain: 1,
};

/** Sources that are never discarded by a provider re-fetch. */
const USER_SOURCES = ['manual', 'aligned'] as const;

const META_SOURCES: readonly MetaSource[] = ['parsed', 'ollama', 'user'];

export function toTrackInfo(r: TrackRow): TrackInfo {
  return {
    videoId: r.video_id,
    title: r.title ?? '',
    channel: r.channel ?? '',
    artist: r.artist,
    track: r.track,
    durationS: r.duration_s,
    isTopic: r.is_topic === 1,
    embeddable: r.embeddable !== 0,
    language: isLanguage(r.language) ? r.language : null,
    metaSource: (META_SOURCES as readonly string[]).includes(r.meta_source ?? '')
      ? (r.meta_source as MetaSource)
      : null,
  };
}

/** Rank-descending, then by source name — a stable order for the inspector. */
export function sortLyricsDocs(docs: LyricsDoc[]): LyricsDoc[] {
  return [...docs].sort(
    (a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind] || a.source.localeCompare(b.source),
  );
}

export class Repo {
  constructor(private db: Database.Database) {}

  getTrack(videoId: string): TrackRow | undefined {
    return this.db
      .prepare('SELECT * FROM tracks WHERE video_id = ?')
      .get(videoId) as TrackRow | undefined;
  }

  upsertTrack(t: {
    videoId: string;
    title: string;
    channel: string;
    isTopic: boolean;
    durationS?: number;
    language?: Language;
  }): void {
    this.db
      .prepare(
        `INSERT INTO tracks (video_id, title, channel, is_topic, duration_s, language)
         VALUES (@videoId, @title, @channel, @isTopic, @durationS, @language)
         ON CONFLICT(video_id) DO UPDATE SET
           title = excluded.title,
           channel = excluded.channel,
           is_topic = excluded.is_topic,
           duration_s = COALESCE(excluded.duration_s, tracks.duration_s),
           language = COALESCE(excluded.language, tracks.language),
           updated_at = datetime('now')`,
      )
      .run({
        videoId: t.videoId,
        title: t.title,
        channel: t.channel,
        isTopic: t.isTopic ? 1 : 0,
        durationS: t.durationS ?? null,
        language: t.language ?? null,
      });
  }

  setMeta(
    videoId: string,
    artist: string | null,
    track: string | null,
    source: MetaSource,
  ): void {
    this.db
      .prepare(
        `UPDATE tracks SET artist = ?, track = ?, meta_source = ?, updated_at = datetime('now')
         WHERE video_id = ?`,
      )
      .run(artist, track, source, videoId);
  }

  setLanguage(videoId: string, language: Language): void {
    this.db
      .prepare(
        `UPDATE tracks SET language = ?, updated_at = datetime('now') WHERE video_id = ?`,
      )
      .run(language, videoId);
  }

  setActiveSource(videoId: string, source: string | null): void {
    this.db
      .prepare(
        `UPDATE tracks SET active_source = ?, updated_at = datetime('now') WHERE video_id = ?`,
      )
      .run(source, videoId);
  }

  setDuration(videoId: string, durationS: number): void {
    this.db
      .prepare(
        `UPDATE tracks SET duration_s = ?, updated_at = datetime('now')
         WHERE video_id = ?`,
      )
      .run(Math.round(durationS), videoId);
  }

  setEmbeddable(videoId: string, embeddable: boolean): void {
    this.db
      .prepare(
        `UPDATE tracks SET embeddable = ?, updated_at = datetime('now')
         WHERE video_id = ?`,
      )
      .run(embeddable ? 1 : 0, videoId);
  }

  getLyrics(videoId: string): LyricsDoc[] {
    const rows = this.db
      .prepare(
        `SELECT source, kind, body, provider_duration_s FROM lyrics
         WHERE video_id = ?`,
      )
      .all(videoId) as LyricsRow[];
    return rows.map((r) => ({
      source: r.source,
      kind: r.kind,
      body: r.body,
      providerDurationS: r.provider_duration_s,
    }));
  }

  upsertLyrics(
    videoId: string,
    source: string,
    kind: LyricsKind,
    body: string,
    providerDurationS?: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO lyrics (video_id, source, kind, body, provider_duration_s, fetched_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(video_id, source) DO UPDATE SET
           kind = excluded.kind,
           body = excluded.body,
           provider_duration_s = excluded.provider_duration_s,
           fetched_at = excluded.fetched_at`,
      )
      .run(videoId, source, kind, body, providerDurationS ?? null);
  }

  deleteLyrics(videoId: string, source: string): void {
    this.db.prepare('DELETE FROM lyrics WHERE video_id = ? AND source = ?').run(videoId, source);
  }

  /** Drop provider-fetched rows (keeps manual / aligned) ahead of a re-fetch. */
  deleteProviderLyrics(videoId: string): void {
    this.db
      .prepare(
        `DELETE FROM lyrics WHERE video_id = ? AND source NOT IN (${USER_SOURCES.map(() => '?').join(',')})`,
      )
      .run(videoId, ...USER_SOURCES);
  }

  /**
   * Active lyrics: the user-pinned source when it exists, else best by rank
   * (synced_word > synced_line > plain). SPEC.md §4.
   */
  activeLyrics(videoId: string): LyricsDoc | null {
    const docs = sortLyricsDocs(this.getLyrics(videoId));
    if (!docs.length) return null;
    const pinned = this.getTrack(videoId)?.active_source;
    return (pinned && docs.find((d) => d.source === pinned)) || docs[0]!;
  }

  getOffset(videoId: string): number {
    const row = this.db
      .prepare('SELECT offset_ms FROM offsets WHERE video_id = ?')
      .get(videoId) as { offset_ms: number } | undefined;
    return row?.offset_ms ?? 0;
  }

  setOffset(videoId: string, offsetMs: number): void {
    this.db
      .prepare(
        `INSERT INTO offsets (video_id, offset_ms) VALUES (?, ?)
         ON CONFLICT(video_id) DO UPDATE SET offset_ms = excluded.offset_ms`,
      )
      .run(videoId, Math.round(offsetMs));
  }

  // ── queue ──────────────────────────────────────────────────

  listQueue(): QueueRow[] {
    return this.db
      .prepare(
        `SELECT q.id, q.video_id, t.title, t.channel, t.artist, t.track,
                t.duration_s, t.is_topic, t.embeddable,
                COALESCE(
                  (SELECT l.kind FROM lyrics l
                   WHERE l.video_id = q.video_id AND l.source = t.active_source),
                  (SELECT l.kind FROM lyrics l WHERE l.video_id = q.video_id
                   ORDER BY CASE l.kind WHEN 'synced_word' THEN 3
                                        WHEN 'synced_line' THEN 2 ELSE 1 END DESC
                   LIMIT 1)) AS best_kind
         FROM queue q LEFT JOIN tracks t ON t.video_id = q.video_id
         ORDER BY q.position`,
      )
      .all() as QueueRow[];
  }

  queueIds(): number[] {
    return (
      this.db.prepare('SELECT id FROM queue ORDER BY position').all() as { id: number }[]
    ).map((r) => r.id);
  }

  /** Insert at `index` (0..n), shifting later rows down. Returns the new id. */
  insertQueueItem(videoId: string, index: number): number {
    return this.db.transaction(() => {
      this.db.prepare('UPDATE queue SET position = position + 1 WHERE position >= ?').run(index);
      const r = this.db
        .prepare('INSERT INTO queue (position, video_id) VALUES (?, ?)')
        .run(index, videoId);
      return Number(r.lastInsertRowid);
    })();
  }

  deleteQueueItem(id: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM queue WHERE id = ?').run(id);
      this.setQueueOrder(this.queueIds());
    })();
  }

  /** Rewrite positions to match `ids` (dense 0..n-1). */
  setQueueOrder(ids: number[]): void {
    const stmt = this.db.prepare('UPDATE queue SET position = ? WHERE id = ?');
    this.db.transaction(() => {
      ids.forEach((id, i) => stmt.run(i, id));
    })();
  }

  clearQueue(): void {
    this.db.prepare('DELETE FROM queue').run();
  }
}
