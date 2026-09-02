import { net } from 'electron';

// All network requests happen in the main process (SPEC.md §2).

export const USER_AGENT =
  'YouTubeKaraoke/0.1.0 (self-use karaoke app; https://github.com/ZhongDev)';

const TOPIC_SUFFIX = ' - Topic';

export interface OEmbedInfo {
  title: string;
  channel: string;
}

export function isTopicChannel(channel: string): boolean {
  return channel.endsWith(TOPIC_SUFFIX);
}

export function topicChannelArtist(channel: string): string {
  return channel.slice(0, -TOPIC_SUFFIX.length).trim();
}

/** Title + channel via YouTube oEmbed (no API key). Throws on failure. */
export async function fetchOEmbed(videoId: string): Promise<OEmbedInfo> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
  const res = await net.fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    // 400/404 = bad id or private; 401 = uploader disabled embedding.
    throw new Error(
      res.status === 401
        ? 'This upload blocks embedding — video info unavailable via oEmbed'
        : `Could not fetch video info (oEmbed ${res.status})`,
    );
  }
  const json = (await res.json()) as { title?: string; author_name?: string };
  return { title: json.title ?? '', channel: json.author_name ?? '' };
}
