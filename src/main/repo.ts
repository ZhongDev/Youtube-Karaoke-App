import type Database from 'better-sqlite3';
import type {
  LibrarySong,
  LyricsDoc,
  LyricsKind,
  MetaSource,
  Playlist,
  TrackInfo,
} from '../shared/ipc';
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

/**
 * A raw Whisper transcription is word-synced but its words are guesses, so
 * it ranks below everything with real text (even plain); it only wins
 * automatically when it is all there is. Mirrored in listQueue's SQL.
 */
const TRANSCRIBED_PENALTY = 2.5;

function docRank(d: LyricsDoc): number {
  return KIND_RANK[d.kind] - (d.source === 'transcribed' ? TRANSCRIBED_PENALTY : 0);
}

/** Sources that are never discarded by a provider re-fetch. */
const USER_SOURCES = ['manual', 'aligned', 'transcribed'] as const;

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
  return [...docs].sort((a, b) => docRank(b) - docRank(a) || a.source.localeCompare(b.source));
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

  // ── reading-aid cache (Phase 6) ──

  getRuby(hash: string, mode: string): string | null {
    const row = this.db
      .prepare('SELECT data FROM ruby_cache WHERE hash = ? AND mode = ?')
      .get(hash, mode) as { data: string } | undefined;
    return row?.data ?? null;
  }

  putRuby(hash: string, mode: string, data: string): void {
    this.db
      .prepare(
        `INSERT INTO ruby_cache (hash, mode, data) VALUES (?, ?, ?)
         ON CONFLICT(hash, mode) DO UPDATE SET data = excluded.data`,
      )
      .run(hash, mode, data);
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
                   ORDER BY (CASE l.kind WHEN 'synced_word' THEN 3
                                         WHEN 'synced_line' THEN 2 ELSE 1 END)
                            - (CASE WHEN l.source = 'transcribed' THEN 2.5 ELSE 0 END) DESC
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

  /** Point an existing queue row at another video (same position, same id). */
  setQueueVideo(id: number, videoId: string): void {
    this.db.prepare('UPDATE queue SET video_id = ? WHERE id = ?').run(videoId, id);
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

  // ── library & playlists ────────────────────────────────────

  /** Every cached song (metadata known), with play stats and best lyrics kind. */
  listLibrary(): LibrarySong[] {
    const rows = this.db
      .prepare(
        `SELECT t.video_id, t.title, t.channel, t.artist, t.track, t.duration_s, t.is_topic,
                t.embeddable, t.created_at,
                (SELECT COUNT(*) FROM plays p WHERE p.video_id = t.video_id) AS play_count,
                (SELECT MAX(p.played_at) FROM plays p WHERE p.video_id = t.video_id) AS last_played_at,
                COALESCE(
                  (SELECT l.kind FROM lyrics l
                   WHERE l.video_id = t.video_id AND l.source = t.active_source),
                  (SELECT l.kind FROM lyrics l WHERE l.video_id = t.video_id
                   ORDER BY (CASE l.kind WHEN 'synced_word' THEN 3
                                         WHEN 'synced_line' THEN 2 ELSE 1 END)
                            - (CASE WHEN l.source = 'transcribed' THEN 2.5 ELSE 0 END) DESC
                   LIMIT 1)) AS best_kind
         FROM tracks t
         WHERE t.title IS NOT NULL
         ORDER BY t.created_at DESC`,
      )
      .all() as Array<{
      video_id: string;
      title: string;
      channel: string | null;
      artist: string | null;
      track: string | null;
      duration_s: number | null;
      is_topic: number;
      embeddable: number;
      created_at: string;
      play_count: number;
      last_played_at: string | null;
      best_kind: LyricsKind | null;
    }>;
    return rows.map((r) => ({
      videoId: r.video_id,
      title: r.title,
      channel: r.channel ?? '',
      artist: r.artist,
      track: r.track,
      durationS: r.duration_s,
      isTopic: r.is_topic === 1,
      embeddable: r.embeddable !== 0,
      lyrics: r.best_kind ?? 'none',
      playCount: r.play_count,
      lastPlayedAt: r.last_played_at,
      addedAt: r.created_at,
    }));
  }

  recordPlay(videoId: string): void {
    this.db.prepare('INSERT INTO plays (video_id) VALUES (?)').run(videoId);
  }

  listPlaylists(): Playlist[] {
    const lists = this.db
      .prepare('SELECT id, name FROM playlists ORDER BY created_at, id')
      .all() as { id: number; name: string }[];
    const items = this.db.prepare(
      'SELECT video_id FROM playlist_items WHERE playlist_id = ? ORDER BY position',
    );
    return lists.map((l) => ({
      id: l.id,
      name: l.name,
      videoIds: (items.all(l.id) as { video_id: string }[]).map((r) => r.video_id),
    }));
  }

  createPlaylist(name: string): number {
    const r = this.db.prepare('INSERT INTO playlists (name) VALUES (?)').run(name);
    return Number(r.lastInsertRowid);
  }

  renamePlaylist(id: number, name: string): void {
    this.db.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(name, id);
  }

  deletePlaylist(id: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(id);
      this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
    })();
  }

  playlistExists(id: number): boolean {
    return this.db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(id) !== undefined;
  }

  /** Append; a song already in the list stays where it is. */
  addToPlaylist(id: number, videoId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO playlist_items (playlist_id, position, video_id)
         VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_items WHERE playlist_id = ?), ?)`,
      )
      .run(id, id, videoId);
  }

  removeFromPlaylist(id: number, videoId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND video_id = ?')
        .run(id, videoId);
      this.setPlaylistOrder(id, this.playlistVideoIds(id));
    })();
  }

  playlistVideoIds(id: number): string[] {
    return (
      this.db
        .prepare('SELECT video_id FROM playlist_items WHERE playlist_id = ? ORDER BY position')
        .all(id) as { video_id: string }[]
    ).map((r) => r.video_id);
  }

  /** Rewrite positions to match `videoIds` (dense 0..n-1). */
  setPlaylistOrder(id: number, videoIds: string[]): void {
    const stmt = this.db.prepare(
      'UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND video_id = ?',
    );
    this.db.transaction(() => {
      videoIds.forEach((v, i) => stmt.run(i, id, v));
    })();
  }
}
