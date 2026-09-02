import type { LyricsDoc, ResolveResult, TrackInfo } from '../shared/ipc';
import { parseVideoTitle, type TitleGuess } from '../shared/titleParser';
import { extractVideoId } from '../shared/youtubeUrl';
import { fetchOEmbed, isTopicChannel, topicChannelArtist } from './metadata';
import { LrclibProvider } from './providers/lrclib';
import type { LyricsProvider, LyricsResult } from './providers/types';
import { Repo, toTrackInfo, type TrackRow } from './repo';

// Tier-1 orchestration (SPEC.md §5): cache → oEmbed → title candidates →
// providers in order → cache the result. A song only ever needs its lyrics
// fetched once; lyric availability must never block playback.

export class LyricsService {
  private providers: LyricsProvider[] = [new LrclibProvider()];
  private inflight = new Map<string, Promise<ResolveResult>>();

  constructor(private repo: Repo) {}

  async resolve(input: string, durationS?: number): Promise<ResolveResult> {
    const videoId = extractVideoId(input);
    if (!videoId) throw new Error('Not a YouTube URL or video id');

    // Collapse concurrent resolves for the same video (the renderer fires an
    // early no-duration resolve and a with-duration one on player ready).
    const existing = this.inflight.get(videoId);
    if (existing) {
      const r = await existing;
      if (r.lyrics || !durationS) {
        if (durationS && !r.track.durationS) this.repo.setDuration(videoId, durationS);
        return r;
      }
      // First attempt found nothing and we now know the duration — retry.
    }

    const p = this.doResolve(videoId, durationS).finally(() =>
      this.inflight.delete(videoId),
    );
    this.inflight.set(videoId, p);
    return p;
  }

  private async doResolve(videoId: string, durationS?: number): Promise<ResolveResult> {
    let row = this.repo.getTrack(videoId);

    // Cache hit: metadata + lyrics already stored — no network at all.
    if (row && this.repo.getLyrics(videoId).length) {
      if (durationS && !row.duration_s) {
        this.repo.setDuration(videoId, durationS);
        row = this.repo.getTrack(videoId)!;
      }
      const best = this.repo.bestLyrics(videoId)!;
      console.log(`[lyrics] cache hit ${videoId} (${best.source}/${best.kind})`);
      return this.result(row, best, true);
    }

    if (!row) {
      const oe = await fetchOEmbed(videoId);
      this.repo.upsertTrack({
        videoId,
        title: oe.title,
        channel: oe.channel,
        isTopic: isTopicChannel(oe.channel),
        ...(durationS ? { durationS } : {}),
      });
      row = this.repo.getTrack(videoId)!;
    } else if (durationS && !row.duration_s) {
      this.repo.setDuration(videoId, durationS);
      row = this.repo.getTrack(videoId)!;
    }

    const title = row.title ?? '';
    const channel = row.channel ?? '';
    const candidates = this.buildCandidates(title, channel);
    console.log(
      `[lyrics] fetching ${videoId}: ${candidates
        .slice(0, 3)
        .map((c) => `[${c.artist} / ${c.track}]`)
        .join(' ')}`,
    );

    const dur = row.duration_s ?? undefined;
    let bestPlain: { res: LyricsResult; cand: TitleGuess } | null = null;

    for (const cand of candidates) {
      for (const provider of this.providers) {
        let results: LyricsResult[];
        try {
          results = await provider.search({
            artist: cand.artist,
            track: cand.track,
            rawTitle: title,
            ...(dur ? { durationS: dur } : {}),
          });
        } catch (err) {
          // A broken provider must never block Tier 1.
          console.warn(`[lyrics] provider ${provider.id} failed:`, err);
          continue;
        }
        const synced = results.find((r) => r.kind !== 'plain');
        if (synced) {
          return this.store(videoId, provider.id, synced, cand);
        }
        const plain = results.find((r) => r.kind === 'plain');
        if (plain && (!bestPlain || plain.confidence > bestPlain.res.confidence)) {
          bestPlain = { res: plain, cand };
        }
      }
    }

    if (bestPlain) {
      return this.store(videoId, this.providers[0]!.id, bestPlain.res, bestPlain.cand);
    }

    // Nothing found — still remember the parsed metadata for the future.
    const top = candidates[0];
    if (top && (top.artist || top.track)) {
      this.repo.setParsedMeta(videoId, top.artist || null, top.track || null);
    }
    console.log(`[lyrics] no lyrics found for ${videoId}`);
    const finalRow = this.repo.getTrack(videoId)!;
    return this.result(finalRow, null, false);
  }

  private buildCandidates(title: string, channel: string): TitleGuess[] {
    const parsed = parseVideoTitle(title, channel);
    if (!isTopicChannel(channel)) return parsed;
    // Auto-generated Topic uploads are exact studio audio: channel minus
    // suffix is the artist, title is the track verbatim. High confidence.
    return [
      { artist: topicChannelArtist(channel), track: title, confidence: 0.95 },
      ...parsed,
    ].slice(0, 6);
  }

  private store(
    videoId: string,
    providerId: string,
    res: LyricsResult,
    cand: TitleGuess,
  ): ResolveResult {
    this.repo.upsertLyrics(videoId, providerId, res.kind, res.body, res.providerDurationS);
    this.repo.setParsedMeta(
      videoId,
      cand.artist || res.providerArtist || null,
      cand.track || res.providerTrackName || null,
    );
    const row = this.repo.getTrack(videoId)!;
    const doc = this.repo.bestLyrics(videoId)!;
    console.log(`[lyrics] stored ${videoId} (${providerId}/${res.kind})`);
    return this.result(row, doc, false);
  }

  private result(
    row: TrackRow,
    lyrics: LyricsDoc | null,
    fromCache: boolean,
  ): ResolveResult {
    const track = toTrackInfo(row);
    return {
      track,
      lyrics,
      offsetMs: this.repo.getOffset(row.video_id),
      fromCache,
      warning: warningFor(track, lyrics),
    };
  }
}

function warningFor(track: TrackInfo, lyrics: LyricsDoc | null): string | null {
  if (!lyrics?.providerDurationS || !track.durationS) return null;
  const diff = track.durationS - lyrics.providerDurationS;
  if (Math.abs(diff) <= 3) return null;
  const artist = track.artist ?? 'artist';
  return (
    `Lyrics are timed for a ${lyrics.providerDurationS}s recording but this video is ` +
    `${track.durationS}s — sync may drift. Try the "${artist} - Topic" upload, or nudge with [ and ].`
  );
}
