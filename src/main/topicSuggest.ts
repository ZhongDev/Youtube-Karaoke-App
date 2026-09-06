import type { TopicSuggestion } from '../shared/ipc';
import { cleanChannelName, cleanTitleForSearch } from '../shared/titleParser';
import { pickTopicUpload, topicSearchQueries } from '../shared/ytSearch';
import type { Repo } from './repo';
import type { YtDlp } from './ytdlp';

// "Artist - Topic" auto-suggestion (SPEC.md §3, §8, Phase 4). Used when an
// upload blocks embedding or its length disagrees with the lyrics' recording.
// Searches through yt-dlp, so it silently yields null when yt-dlp is missing.
// One answer per video per session — the queries cost ~2 s each.

export class TopicSuggester {
  private cache = new Map<string, Promise<TopicSuggestion | null>>();

  constructor(
    private repo: Repo,
    private ytdlp: YtDlp,
  ) {}

  suggest(videoId: string): Promise<TopicSuggestion | null> {
    const cached = this.cache.get(videoId);
    if (cached) return cached;
    const p = this.compute(videoId).catch((err: unknown) => {
      console.warn(`[topic] suggestion for ${videoId} failed:`, err);
      this.cache.delete(videoId); // transient (yt-dlp missing/timeout) → retry later
      return null;
    });
    this.cache.set(videoId, p);
    return p;
  }

  private async compute(videoId: string): Promise<TopicSuggestion | null> {
    const row = this.repo.getTrack(videoId);
    if (!row || row.is_topic === 1) return null;
    const artist = (row.artist ?? cleanChannelName(row.channel ?? '')).trim();
    const track = (row.track ?? cleanTitleForSearch(row.title ?? '')).trim();
    if (!track) return null;
    const targetDurationS = this.repo.activeLyrics(videoId)?.providerDurationS ?? null;

    let best: ReturnType<typeof pickTopicUpload> = null;
    for (const query of topicSearchQueries(artist, track)) {
      const results = (await this.ytdlp.search(query)).map((r) => ({
        ...r,
        embeddable: this.repo.getTrack(r.videoId)?.embeddable !== 0,
      }));
      const pick = pickTopicUpload(results, {
        artist,
        track,
        excludeIds: [videoId],
        targetDurationS,
      });
      if (pick && (!best || pick.score > best.score)) best = pick;
      if (best && best.score >= 0.9) break;
    }

    if (!best) {
      console.log(`[topic] no Topic upload found for ${videoId} [${artist} / ${track}]`);
      return null;
    }
    const r = best.result;
    console.log(
      `[topic] ${videoId} → ${r.videoId} "${r.title}" (${r.channel}, ${r.durationS ?? '?'}s, score ${best.score.toFixed(2)})`,
    );
    return { videoId: r.videoId, title: r.title, channel: r.channel, durationS: r.durationS };
  }
}
