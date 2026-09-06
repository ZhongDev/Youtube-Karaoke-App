import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'node:path';

// Versioned migrations. Index i is the migration that brings the DB from
// user_version i to i+1. Never edit an entry after it has shipped — append.
const MIGRATIONS: string[] = [
  // v1 — initial schema (SPEC.md §4)
  `
  CREATE TABLE tracks (
    video_id   TEXT PRIMARY KEY,
    title      TEXT,
    channel    TEXT,
    artist     TEXT,
    track      TEXT,
    duration_s INTEGER,
    is_topic   INTEGER DEFAULT 0,
    embeddable INTEGER DEFAULT 1,
    language   TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE lyrics (
    video_id   TEXT NOT NULL,
    source     TEXT NOT NULL,   -- 'lrclib' | 'netease' | 'manual' | 'aligned' | …
    kind       TEXT NOT NULL,   -- 'synced_word' | 'synced_line' | 'plain'
    body       TEXT NOT NULL,   -- raw LRC / enhanced LRC / plain text
    fetched_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (video_id, source)
  );

  CREATE TABLE offsets (
    video_id  TEXT PRIMARY KEY,
    offset_ms INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE queue (
    position INTEGER NOT NULL,
    video_id TEXT NOT NULL
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  `,
  // v2 — provider-reported track duration per lyrics row, for drift warnings
  // (SPEC.md §8: |videoDuration − lyricDuration| > 3s ⇒ warn).
  `ALTER TABLE lyrics ADD COLUMN provider_duration_s INTEGER;`,
  // v3 — queue rows get a stable id so they can be reordered/removed and the
  // same video can be queued twice. (v1's queue table was never written to.)
  `
  DROP TABLE queue;
  CREATE TABLE queue (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    position INTEGER NOT NULL,   -- dense 0..n-1, 0 = now playing
    video_id TEXT NOT NULL
  );
  CREATE INDEX queue_position ON queue(position);
  `,
  // v4 — Phase 3: user-pinned lyrics source (null = best by rank) and the
  // provenance of artist/track ('parsed' | 'ollama' | 'user'; user edits
  // are never overwritten by a re-fetch).
  `
  ALTER TABLE tracks ADD COLUMN active_source TEXT;
  ALTER TABLE tracks ADD COLUMN meta_source TEXT;
  `,
  // v5 — Phase 6: cached reading aids (furigana / romaji / romanization),
  // keyed by a hash of language + lyrics body so a changed document simply
  // misses (stale rows are harmless).
  `
  CREATE TABLE ruby_cache (
    hash       TEXT NOT NULL,   -- sha1 of language + body
    mode       TEXT NOT NULL,   -- 'furigana' | 'romaji'
    data       TEXT NOT NULL,   -- JSON RubySegment[][] (one entry per LRC line)
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (hash, mode)
  );
  `,
];

export function getDbPath(): string {
  return path.join(app.getPath('userData'), 'karaoke.db');
}

export function openDatabase(dbPath = getDbPath()): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v];
    if (!sql) continue;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function schemaVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}
