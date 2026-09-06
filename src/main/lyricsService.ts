import type { LyricsDoc, MetaSource, ProviderId, ResolveResult, TrackInfo } from '../shared/ipc';
import { detectLanguage, detectTrackLanguage, type Language } from '../shared/language';
import { lyricsKindOf } from '../shared/lrc';
import { parseVideoTitle, type TitleGuess } from '../shared/titleParser';
import { extractVideoId } from '../shared/youtubeUrl';
import { fetchOEmbed, isTopicChannel, topicChannelArtist } from './metadata';
import { askOllamaForMeta } from './ollama';
import { LrclibProvider } from './providers/lrclib';
import { NeteaseProvider } from './providers/netease';
import type { LyricsProvider, LyricsResult } from './providers/types';
import { Repo, sortLyricsDocs, toTrackInfo, type TrackRow } from './repo';
import type { SettingsStore } from './settings';

// Tier-1 orchestration (SPEC.md §5): cache → oEmbed → title candidates →
// providers in language order → cache the result. A song only ever needs
// its lyrics fetched once; lyric availability must never block playback.
//
// Phase 3 additions: NetEase, language-ordered + toggleable providers, the
// optional Ollama title assist, and the inspector operations (pin a source,
// manual paste, metadata edit → re-fetch).

/** A title guess plus where it came from (decides tracks.meta_source). */
interface Candidate extends TitleGuess {
  source: MetaSource;
}

/** Heuristic confidence below this → ask Ollama (when enabled). */
const LLM_ASSIST_BELOW = 0.7;

export class LyricsService {
  private providers: Record<ProviderId, LyricsProvider> = {
    lrclib: new LrclibProvider(),
    netease: new NeteaseProvider(),
  };
  private inflight = new Map<string, Promise<ResolveResult>>();

  constructor(
    private repo: Repo,
    private settings: SettingsStore,
  ) {}

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
    return this.track(videoId, () => this.doResolve(videoId, durationS, false));
  }

  // ── inspector operations (SPEC.md §7) ──

  /** Pin the active source (must exist), or null to return to best-by-rank. */
  setActive(videoId: string, source: string | null): ResolveResult {
    this.requireTrack(videoId);
    if (source !== null && !this.repo.getLyrics(videoId).some((d) => d.source === source)) {
      throw new Error(`No "${source}" lyrics stored for this video`);
    }
    this.repo.setActiveSource(videoId, source);
    console.log(`[lyrics] ${videoId} active source → ${source ?? 'auto'}`);
    return this.current(videoId);
  }

  /** Store pasted text as 'manual' and make it active; empty text removes it. */
  setManual(videoId: string, text: string): ResolveResult {
    const row = this.requireTrack(videoId);
    const body = text.replace(/\r\n?/g, '\n').trim();
    if (!body) {
      this.repo.deleteLyrics(videoId, 'manual');
      if (row.active_source === 'manual') this.repo.setActiveSource(videoId, null);
      console.log(`[lyrics] ${videoId} manual lyrics removed`);
    } else {
      const kind = lyricsKindOf(body);
      this.repo.upsertLyrics(videoId, 'manual', kind, body);
      this.repo.setActiveSource(videoId, 'manual');
      this.repo.setLanguage(videoId, detectTrackLanguage(row.title ?? '', body));
      console.log(`[lyrics] ${videoId} manual lyrics stored (${kind}, ${body.length} chars)`);
    }
    return this.current(videoId);
  }

  /** User-edited artist/track: becomes the sole search candidate, then re-fetch. */
  setMeta(videoId: string, artist: string, track: string): Promise<ResolveResult> {
    this.requireTrack(videoId);
    this.repo.setMeta(videoId, artist.trim() || null, track.trim() || null, 'user');
    console.log(`[lyrics] ${videoId} metadata edited → [${artist} / ${track}]`);
    return this.refetch(videoId);
  }

  /** Discard provider results and search again with the current metadata. */
  async refetch(videoId: string): Promise<ResolveResult> {
    this.requireTrack(videoId);
    // Let an in-flight resolve land first so the two never interleave writes.
    const existing = this.inflight.get(videoId);
    if (existing) await existing.catch(() => undefined);
    this.repo.deleteProviderLyrics(videoId);
    const dur = this.repo.getTrack(videoId)?.duration_s ?? undefined;
    return this.track(videoId, () => this.doResolve(videoId, dur, true));
  }

  // ── internals ──

  private track(videoId: string, run: () => Promise<ResolveResult>): Promise<ResolveResult> {
    const p = run().finally(() => {
      if (this.inflight.get(videoId) === p) this.inflight.delete(videoId);
    });
    this.inflight.set(videoId, p);
    return p;
  }

  private requireTrack(videoId: string): TrackRow {
    const row = this.repo.getTrack(videoId);
    if (!row) throw new Error('Unknown video — play or queue it first');
    return row;
  }

  private current(videoId: string): ResolveResult {
    return this.result(this.requireTrack(videoId), this.repo.activeLyrics(videoId), true);
  }

  private async doResolve(
    videoId: string,
    durationS: number | undefined,
    force: boolean,
  ): Promise<ResolveResult> {
    let row = this.repo.getTrack(videoId);

    // Cache hit: metadata + lyrics already stored — no network at all.
    if (!force && row && this.repo.getLyrics(videoId).length) {
      if (durationS && !row.duration_s) this.repo.setDuration(videoId, durationS);
      const active = this.repo.activeLyrics(videoId)!;
      if (!row.language) {
        // Rows from before language detection existed.
        this.repo.setLanguage(videoId, detectTrackLanguage(row.title ?? '', active.body));
      }
      row = this.repo.getTrack(videoId)!;
      console.log(`[lyrics] cache hit ${videoId} (${active.source}/${active.kind})`);
      return this.result(row, active, true);
    }

    if (!row) {
      const oe = await fetchOEmbed(videoId);
      this.repo.upsertTrack({
        videoId,
        title: oe.title,
        channel: oe.channel,
        isTopic: isTopicChannel(oe.channel),
        language: detectLanguage(`${oe.title} ${oe.channel}`),
        ...(durationS ? { durationS } : {}),
      });
      row = this.repo.getTrack(videoId)!;
    } else if (durationS && !row.duration_s) {
      this.repo.setDuration(videoId, durationS);
      row = this.repo.getTrack(videoId)!;
    }

    const title = row.title ?? '';
    const channel = row.channel ?? '';
    const language: Language = detectLanguage(`${title} ${channel}`);
    const candidates = await this.buildCandidates(row);
    const providers = this.providersFor(language);
    console.log(
      `[lyrics] fetching ${videoId} [${language}] via ${providers.map((p) => p.id).join(',') || 'no providers!'}: ${candidates
        .slice(0, 3)
        .map((c) => `[${c.artist} / ${c.track}]`)
        .join(' ')}`,
    );

    const dur = row.duration_s ?? undefined;
    let bestPlain: { res: LyricsResult; cand: Candidate; providerId: string } | null = null;

    for (const cand of candidates) {
      for (const provider of providers) {
        let results: LyricsResult[];
        try {
          results = await provider.search({
            artist: cand.artist,
            track: cand.track,
            rawTitle: title,
            language,
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
          bestPlain = { res: plain, cand, providerId: provider.id };
        }
      }
    }

    if (bestPlain) {
      return this.store(videoId, bestPlain.providerId, bestPlain.res, bestPlain.cand);
    }

    // Nothing found — still remember the parsed metadata for the future.
    const top = candidates[0];
    if (top && row.meta_source !== 'user' && (top.artist || top.track)) {
      this.repo.setMeta(videoId, top.artist || null, top.track || null, top.source);
    }
    console.log(`[lyrics] no lyrics found for ${videoId}`);
    // Manual/aligned lyrics survive a re-fetch and may still be active.
    return this.result(this.repo.getTrack(videoId)!, this.repo.activeLyrics(videoId), false);
  }

  /** Enabled providers, ordered by language (SPEC.md §5): CJK → NetEase first. */
  private providersFor(language: Language): LyricsProvider[] {
    const enabled = this.settings.get().providers;
    const order: ProviderId[] =
      language === 'ja' || language === 'ko' ? ['netease', 'lrclib'] : ['lrclib', 'netease'];
    return order.filter((id) => enabled[id]).map((id) => this.providers[id]);
  }

  private async buildCandidates(row: TrackRow): Promise<Candidate[]> {
    const title = row.title ?? '';
    const channel = row.channel ?? '';

    // A user edit is authoritative: search with exactly that pair.
    if (row.meta_source === 'user' && (row.artist || row.track)) {
      return [{ artist: row.artist ?? '', track: row.track ?? '', confidence: 1, source: 'user' }];
    }

    const parsed: Candidate[] = parseVideoTitle(title, channel).map((g) => ({
      ...g,
      source: 'parsed',
    }));
    if (isTopicChannel(channel)) {
      // Auto-generated Topic uploads are exact studio audio: channel minus
      // suffix is the artist, title is the track verbatim. High confidence.
      const topic: Candidate = {
        artist: topicChannelArtist(channel),
        track: title,
        confidence: 0.95,
        source: 'parsed',
      };
      return [topic, ...parsed].slice(0, 6);
    }

    const ollama = this.settings.get().ollama;
    if (ollama.enabled && (parsed[0]?.confidence ?? 0) < LLM_ASSIST_BELOW) {
      const llm = await askOllamaForMeta(ollama, title, channel);
      if (llm && llm.confidence >= 0.5) {
        const dup = parsed.some((c) => c.artist === llm.artist && c.track === llm.track);
        if (!dup) {
          parsed.unshift({
            artist: llm.artist,
            track: llm.track,
            confidence: Math.min(0.9, llm.confidence),
            source: 'ollama',
          });
        }
      }
    }
    return parsed.slice(0, 6);
  }

  private store(
    videoId: string,
    providerId: string,
    res: LyricsResult,
    cand: Candidate,
  ): ResolveResult {
    this.repo.upsertLyrics(videoId, providerId, res.kind, res.body, res.providerDurationS);
    const row = this.repo.getTrack(videoId)!;
    if (row.meta_source !== 'user') {
      this.repo.setMeta(
        videoId,
        cand.artist || res.providerArtist || null,
        cand.track || res.providerTrackName || null,
        cand.source,
      );
    }
    this.repo.setLanguage(videoId, detectTrackLanguage(row.title ?? '', res.body));
    console.log(`[lyrics] stored ${videoId} (${providerId}/${res.kind})`);
    return this.result(this.repo.getTrack(videoId)!, this.repo.activeLyrics(videoId), false);
  }

  private result(row: TrackRow, lyrics: LyricsDoc | null, fromCache: boolean): ResolveResult {
    const track = toTrackInfo(row);
    return {
      track,
      lyrics,
      sources: sortLyricsDocs(this.repo.getLyrics(row.video_id)),
      activeSource: row.active_source,
      offsetMs: this.repo.getOffset(row.video_id),
      fromCache,
      warning: warningFor(track, lyrics),
      driftS: driftFor(track, lyrics),
    };
  }
}

/** Signed video − lyrics length when beyond the SPEC.md §8 threshold, else null. */
function driftFor(track: TrackInfo, lyrics: LyricsDoc | null): number | null {
  if (!lyrics?.providerDurationS || !track.durationS) return null;
  const diff = track.durationS - lyrics.providerDurationS;
  return Math.abs(diff) <= 3 ? null : diff;
}

function warningFor(track: TrackInfo, lyrics: LyricsDoc | null): string | null {
  const diff = driftFor(track, lyrics);
  if (diff === null || !lyrics?.providerDurationS) return null;
  const artist = track.artist ?? 'artist';
  return (
    `Lyrics are timed for a ${lyrics.providerDurationS}s recording but this video is ` +
    `${track.durationS}s — sync may drift. Try the "${artist} - Topic" upload, or nudge with [ and ].`
  );
}
