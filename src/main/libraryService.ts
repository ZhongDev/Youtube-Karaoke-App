import type { LibrarySnapshot } from '../shared/ipc';
import { moveTo } from '../shared/library';
import type { Repo } from './repo';

// Library (every cached song) and playlists. Main owns the data; the
// renderer gets full snapshots (small: one row per cached song) whenever
// anything that feeds them changes — plays, playlist edits, and the queue
// service's own refreshes (new metadata / lyrics for a song).

export class LibraryService {
  private rev = 0;

  constructor(
    private repo: Repo,
    private send: (snapshot: LibrarySnapshot) => void,
  ) {}

  snapshot(): LibrarySnapshot {
    return { rev: this.rev, songs: this.repo.listLibrary(), playlists: this.repo.listPlaylists() };
  }

  broadcast(): void {
    this.rev++;
    this.send(this.snapshot());
  }

  recordPlay(videoId: string): void {
    this.repo.recordPlay(videoId);
    this.broadcast();
  }

  create(name: string): number {
    const n = name.trim();
    if (!n) throw new Error('Give the playlist a name');
    const id = this.repo.createPlaylist(n);
    console.log(`[library] playlist #${id} "${n}" created`);
    this.broadcast();
    return id;
  }

  rename(id: number, name: string): void {
    const n = name.trim();
    if (!n) throw new Error('Give the playlist a name');
    this.require(id);
    this.repo.renamePlaylist(id, n);
    this.broadcast();
  }

  delete(id: number): void {
    this.require(id);
    this.repo.deletePlaylist(id);
    console.log(`[library] playlist #${id} deleted`);
    this.broadcast();
  }

  add(id: number, videoId: string): void {
    this.require(id);
    if (!this.repo.getTrack(videoId)) throw new Error('Unknown video — play or queue it first');
    this.repo.addToPlaylist(id, videoId);
    this.broadcast();
  }

  remove(id: number, videoId: string): void {
    this.require(id);
    this.repo.removeFromPlaylist(id, videoId);
    this.broadcast();
  }

  move(id: number, videoId: string, toIndex: number): void {
    this.require(id);
    const ids = this.repo.playlistVideoIds(id);
    const from = ids.indexOf(videoId);
    if (from < 0) throw new Error('That song is not in the playlist');
    this.repo.setPlaylistOrder(id, moveTo(ids, from, toIndex));
    this.broadcast();
  }

  private require(id: number): void {
    if (!this.repo.playlistExists(id)) throw new Error('Playlist no longer exists');
  }
}
