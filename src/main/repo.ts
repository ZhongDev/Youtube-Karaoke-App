import type Database from 'better-sqlite3';
import type { LyricsDoc, LyricsKind, TrackInfo } from '../shared/ipc';

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
}

interface LyricsRow {
  source: string;
  kind: LyricsKind;
  body: string;
  provider_duration_s: number | null;
}

const KIND_RANK: Record<LyricsKind, number> = {
  synced_word: 3,
  synced_line: 2,
  plain: 1,
};

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
  };
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
  }): void {
    this.db
      .prepare(
        `INSERT INTO tracks (video_id, title, channel, is_topic, duration_s)
         VALUES (@videoId, @title, @channel, @isTopic, @durationS)
         ON CONFLICT(video_id) DO UPDATE SET
           title = excluded.title,
           channel = excluded.channel,
           is_topic = excluded.is_topic,
           duration_s = COALESCE(excluded.duration_s, tracks.duration_s),
           updated_at = datetime('now')`,
      )
      .run({
        videoId: t.videoId,
        title: t.title,
        channel: t.channel,
        isTopic: t.isTopic ? 1 : 0,
        durationS: t.durationS ?? null,
      });
  }

  setParsedMeta(videoId: string, artist: string | null, track: string | null): void {
    this.db
      .prepare(
        `UPDATE tracks SET artist = ?, track = ?, updated_at = datetime('now')
         WHERE video_id = ?`,
      )
      .run(artist, track, videoId);
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

  /** Best available lyrics by rank: synced_word > synced_line > plain. */
  bestLyrics(videoId: string): LyricsDoc | null {
    const docs = this.getLyrics(videoId);
    if (!docs.length) return null;
    docs.sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind]);
    return docs[0]!;
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
}
