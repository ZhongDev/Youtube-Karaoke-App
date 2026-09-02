# Build Spec: Self-Use YouTube Karaoke App

You are building a personal-use desktop karaoke app. It plays YouTube videos via the official IFrame Player and overlays time-synced lyrics, with a song queue, per-video sync offset, and a local lyrics pipeline that is entirely free to run. Primary platform is macOS (Apple Silicon). Single user, no accounts, no server.

Work through the **Implementation Phases** at the bottom in order. Before writing code for each phase, briefly propose your approach and file structure for that phase, then implement it. Do not skip ahead: each phase has acceptance criteria that must pass before moving on.

---

## 1. Principles & Constraints

- **Zero running cost.** No paid APIs, no API keys required for core functionality. All lyric sources are free/public; all AI processing is local.
- **Local-first.** Everything (lyrics, metadata, offsets, queue) is cached in a local SQLite database. A song should only ever need its lyrics fetched once.
- **Self-use pragmatism.** This is a personal tool, not a product. Prefer simple, debuggable code over abstraction. But DO keep the lyrics-provider layer pluggable, because unofficial providers break and get swapped out.
- **Language targets:** English, Japanese, Korean — in that priority. CJK handling (script detection, original-script search, romanization) is a first-class concern, not an afterthought.
- **Graceful degradation.** Synced lyrics → plain lyrics → nothing, with the UI clearly showing which mode it's in. Never block playback on lyrics availability.

## 2. Tech Stack

- **Electron** (latest stable) scaffolded with **Electron Forge + Vite**.
- **React + TypeScript (strict)** in the renderer.
- **better-sqlite3** in the main process for the cache DB.
- Electron security defaults: `contextIsolation: true`, `nodeIntegration: false`, a preload script exposing a typed IPC API via `contextBridge`.
- **All network requests happen in the main process** (avoids CORS entirely; lets us set custom User-Agent headers). The renderer only talks to the preload API.
- Testing: **vitest** for pure logic (LRC parser, title parser, sync clock).
- Styling: plain CSS or CSS modules, dark theme. No UI framework needed.
- Python sidecar (Phase 5 only): managed with **uv**, invoked as a child process.

## 3. Architecture Overview

```
┌─ Renderer (React) ─────────────────────────────┐
│  YouTube IFrame Player │ Lyrics overlay        │
│  Queue UI │ Search UI │ Settings │ Offset HUD  │
└──────────────┬─────────────────────────────────┘
               │ typed IPC (contextBridge)
┌──────────────┴─────────────────────────────────┐
│  Main process                                  │
│  • SQLite cache (tracks/lyrics/offsets/queue)  │
│  • Lyrics providers (LRCLIB, NetEase, …)       │
│  • Metadata resolver (oEmbed + parser + LLM)   │
│  • Child processes: yt-dlp (search/audio),     │
│    Python alignment worker (Phase 5)           │
└────────────────────────────────────────────────┘
```

### YouTube playback

- Use the official **YouTube IFrame Player API** loaded in the renderer.
- The IFrame API can be unreliable when the host page is served from `file://`. Register a custom app protocol (e.g. `app://`) via `protocol.registerSchemesAsPrivileged` (standard + secure) and serve the production renderer from it. In dev, the Vite dev server origin is fine.
- Handle player error codes, especially **101/150 (embedding disabled by uploader)**: mark the video as `embeddable = false` in the DB and show a clear "this upload blocks embedding — try another upload of this song" state (Phase 4 auto-suggests the auto-generated "Topic" upload instead).
- Detect auto-generated **"<Artist> - Topic" channel uploads**: these are exact studio audio, so their duration matches lyric databases and LRC files sync with near-zero offset. Prefer them when available; store `is_topic` on the track.

### Sync clock (the core of the app — get this right)

`player.getCurrentTime()` only updates every ~250ms, so naive polling makes highlighting jerky. Implement a small clock model:

- Poll `getCurrentTime()` on an interval (250ms).
- Maintain `estimatedTime = lastPolledTime + (performance.now() - lastPollWallclock) / 1000 * playbackRate` while state is PLAYING; freeze while paused/buffering.
- On each poll, if `|polled - estimated| > 0.35s`, treat it as a seek and snap; otherwise gently correct (or just adopt the polled value — keep it simple first).
- Drive the lyrics highlight from `estimatedTime + userOffsetSeconds + lrcFileOffset` inside a `requestAnimationFrame` loop.
- Unit-test the clock logic with a fake timer.

## 4. Data Model (SQLite)

```sql
tracks   (video_id TEXT PK, title TEXT, channel TEXT, artist TEXT, track TEXT,
          duration_s INTEGER, is_topic INTEGER, embeddable INTEGER DEFAULT 1,
          language TEXT,          -- detected: en/ja/ko/other
          created_at, updated_at)

lyrics   (video_id TEXT, source TEXT,      -- 'lrclib' | 'netease' | 'manual' | 'aligned' | …
          kind TEXT,                       -- 'synced_line' | 'synced_word' | 'plain'
          body TEXT,                       -- raw LRC / enhanced LRC / plain text
          fetched_at,
          PRIMARY KEY (video_id, source))

offsets  (video_id TEXT PK, offset_ms INTEGER DEFAULT 0)

queue    (position INTEGER, video_id TEXT)  -- persisted across restarts

settings (key TEXT PK, value TEXT)
```

Active lyrics for a video = best available by rank: `synced_word > synced_line > plain`, user can override the source in the UI.

## 5. Lyrics Pipeline

### Tier 1 — Fetch existing synced lyrics (the workhorse)

Provider interface:

```ts
interface LyricsProvider {
  id: string;
  search(q: { artist: string; track: string; album?: string;
              durationS?: number; rawTitle: string; language?: string }):
    Promise<LyricsResult[]>;   // { kind, body, confidence, providerTrackName, providerArtist }
}
```

**Provider 1: LRCLIB** (primary — free, no key, community DB; be a polite client):
- `GET https://lrclib.net/api/get?artist_name=..&track_name=..&album_name=..&duration=..` — exact match; the service matches duration within ±2s. Use the track duration if known (Topic uploads), otherwise skip the duration param and fall through to search.
- `GET https://lrclib.net/api/search?track_name=..&artist_name=..` (and a fallback with `q=` on the raw parsed title) — rank results yourself by fuzzy title/artist match + duration proximity.
- Set a descriptive `User-Agent` (app name + repo URL) as their docs request. No key needed.
- Response fields: `syncedLyrics` (LRC), `plainLyrics`, `instrumental`, `duration`.

**Provider 2: NetEase Cloud Music** (huge CJK library; unofficial, may break — isolate it):
- Search: `https://music.163.com/api/search/get?s=<query>&type=1&limit=10`
- Lyrics: `https://music.163.com/api/song/lyric?id=<songId>&lv=1&kv=1&tv=-1` (`lrc.lyric` is standard LRC).
- **Search in the original script** for JP/KR songs (use the parsed artist/title as-is, not romanized).
- Wrap in try/catch with short timeout; if it breaks, log and move on. A disabled/broken provider must never block Tier 1.

Provider priority by detected language: EN → [lrclib, netease]; JA/KO → [netease, lrclib] (try both regardless, this just orders them). Cache every successful result. Add a settings toggle to enable/disable each provider.

Script/language detection: simple Unicode-range heuristic on title + fetched lyrics (Hiragana/Katakana → ja, Hangul → ko, else en/other). Store on track.

### Tier 2 — Plain-lyrics fallback

If no synced lyrics found but plain lyrics exist (LRCLIB returns these too), store them and display in "scroll mode": untimed, manually scrollable, clearly labeled UNSYNCED. These become the input text for Tier 3 alignment later.

Also provide a **manual paste box**: user pastes lyrics text (or a full LRC file) from anywhere; stored as source `manual`.

### Tier 3 — Local forced alignment (Phase 5)

Python worker that turns (audio + known lyric text) into word-level enhanced LRC:

1. `yt-dlp -f bestaudio` the video's audio to a temp dir.
2. **Demucs** to isolate vocals (two-stem mode is enough).
3. **stable-ts** (Whisper-based) in **alignment mode** against the reference lyric text, with language hint. Alignment against known text, NOT free transcription. Model size configurable (default `large-v3`, allow `medium` for speed); runs on Apple Silicon.
4. Emit enhanced LRC (`[mm:ss.xx]` line stamps + `<mm:ss.xx>` word stamps) on stdout as JSON `{ ok, enhancedLrc, warnings }`.

Node side: spawn with `uv run`, stream progress to the UI, save result as source `aligned`, kind `synced_word`. This is a background job — playback must remain usable while it runs. Raw transcription (no reference text) is a stretch goal; don't build it until everything else works.

## 6. Metadata Resolution (YouTube title → artist/track)

1. Fetch `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=<id>&format=json` in main process → `title`, `author_name`. No API key.
2. If channel ends in `" - Topic"`: artist = channel minus suffix, track = title verbatim. Done, high confidence.
3. Otherwise run a **heuristic parser** (pure function, well unit-tested): strip noise tokens — `(Official Music Video)`, `[MV]`, `【MV】`, `(Official Video)`, `(Lyric Video)`, `M/V`, `(Audio)`, `full ver.`, feat-clauses for search purposes, etc. — then split on ` - `, `−`, `–`, `/`, `「」` patterns. Handle both `Artist - Title` and `Title - Artist` ambiguity by trying both orders against providers if the first search misses. Cover EN/JP/KR title conventions in tests (collect ~20 realistic gnarly examples as fixtures).
4. **Optional local-LLM assist:** if an Ollama server is reachable at `http://localhost:11434` (endpoint + model name configurable in settings, off by default), send the raw title/channel and ask for strict JSON `{artist, track, confidence}`. Use it when heuristics are low-confidence. Never required, never blocks — fall back to heuristics on any error or timeout.
5. Metadata is always **user-editable** in the UI; edits trigger a lyrics re-fetch.

## 7. UI Spec

Dark, high-contrast, readable from a couch (this will be mirrored to a TV).

- **Player view:** video prominent; lyrics overlay in the lower third (over the video, subtle gradient backdrop for legibility) or in a panel below — make it a toggle. Show: previous line (dimmed), **current line (large, highlighted)**, next 1–2 lines (dimmed). Smooth transition on line change. For `synced_word` lyrics, fill/highlight word-by-word.
- **Sync offset HUD:** `[` / `]` nudge −/+100ms, with Shift −/+500ms, `\` resets. Show a transient toast with the current offset. Persist per video immediately.
- **Queue panel** (collapsible sidebar): add via URL paste (MVP) or search; drag-to-reorder; remove; now-playing indicator; auto-advance on song end (player state ENDED); "play next" vs "add to end".
- **Search** (Phase 4): text box → `yt-dlp "ytsearch10:<query>" --dump-json --flat-playlist` in main process → results with title/channel/duration/thumbnail → click to enqueue. No API key.
- **Song status badges:** lyric state per queue item: ✓ word-synced / ✓ line-synced / ≈ plain / ✗ none / ⏳ fetching.
- **Lyrics inspector modal:** view raw LRC, switch active source, paste manual lyrics/LRC, edit artist/track, re-fetch button, (Phase 5) "Align lyrics" button with progress.
- **Settings:** provider toggles, Ollama endpoint/model, Whisper model size, romanization toggle, cache folder info.
- **Fullscreen/TV mode:** hides everything except video + lyrics + a minimal next-up strip.
- **Romanization (Phase 6):** for `ja` tracks, optional romaji (or furigana) sub-line under the current line using **kuroshiro + kuromoji**; convert lazily per song and cache in DB. Korean romanization is a stretch goal.

## 8. Known Pitfalls (design for these)

- **Offset drift:** LRC timestamps are synced to studio recordings; music videos have intros/outros/different cuts. This is why per-video offset is a core feature, not polish. Duration mismatch between video and provider result is the signal — if `|videoDuration - lyricDuration| > 3s`, warn in the UI and suggest the Topic upload.
- **Embed-blocked videos** (error 101/150): common for official MVs. Must be handled from Phase 1 (graceful error state), with auto-alternative-suggestion later.
- **Provider fragility:** NetEase endpoints are unofficial. Isolate, timeout, degrade.
- **Mixed-script metadata:** J-pop/K-pop titles mix scripts and decorations; never assume `Artist - Title`. This is the most test-worthy pure logic in the app alongside the LRC parser.
- **LRC quirks:** multiple timestamps per line (`[01:10.00][02:30.00]same line`), metadata tags (`[ti:]`, `[ar:]`, `[offset:+500]` — apply it!), enhanced word tags `<mm:ss.xx>`, CRLF, BOM, empty lines used as spacing. Parser must be robust and fully unit-tested.
- **Don't fetch audio during normal playback.** yt-dlp audio extraction is only for the explicit, user-triggered alignment job.

## 9. Implementation Phases

### Phase 0 — Scaffold
Electron Forge + Vite + React + TS strict; custom `app://` protocol for prod; preload with typed IPC; better-sqlite3 with migrations; dark shell layout.
**AC:** App launches; a hardcoded YouTube video plays via IFrame API; current playback time updates on screen; DB file is created with schema.

### Phase 1 — Core karaoke loop
Paste URL → oEmbed metadata → heuristic title parser → LRCLIB provider → LRC parser → synced line overlay driven by the sync clock → offset hotkeys persisted → everything cached (relaunch replays instantly from cache). Embed-blocked error state.
**AC:** For a well-known English song (use a Topic upload), lyrics highlight in sync end-to-end; offset nudge works and persists; second load hits cache (verify: works offline); vitest green for LRC parser, title parser, sync clock.

### Phase 2 — Queue
Persisted queue with add/remove/drag-reorder, auto-advance, play-next, status badges, now-playing.
**AC:** Queue 3 songs, they play through hands-free; queue survives restart.

### Phase 3 — Providers & metadata hardening
NetEase provider; language detection; provider ordering + settings toggles; plain-lyrics scroll mode; manual paste; lyrics inspector modal with source switching and metadata editing; optional Ollama title parsing.
**AC:** A J-pop and a K-pop track both get synced lyrics; a no-synced-result track falls back to plain scroll mode; editing metadata re-fetches correctly.

### Phase 4 — Search & TV mode
yt-dlp search-to-enqueue with thumbnails; fullscreen TV mode; Topic-upload auto-suggestion for embed-blocked/badly-offset videos.
**AC:** Type a song name, enqueue from results, present fullscreen on an external display comfortably.

### Phase 5 — Local alignment worker
uv-managed Python sidecar (yt-dlp → Demucs → stable-ts alignment) producing enhanced LRC; background job queue with progress UI; word-level highlight rendering.
**AC:** A track that only had plain lyrics gets word-synced lyrics generated locally and renders with word-level highlighting; app stays responsive during the job.

### Phase 6 — Nice-to-haves (pick with me before building)
Romaji/furigana sub-line; auto-offset estimation (align first ~45s of vocals to detect intro length); raw-transcription fallback; Korean romanization; pitch/scoring gimmicks.

## 10. Non-Goals

No accounts/auth, no cloud sync, no Windows/Linux packaging for now, no downloading/streaming audio for playback (playback is always the official embed), no scraping of Musixmatch's paid API, no multi-user rooms.

## 11. Conventions

- TypeScript strict everywhere; no `any` in the IPC boundary — define shared types in one place.
- Keep providers, parsers, and the sync clock as pure/isolated modules with tests. UI can be looser.
- Minimal dependencies; justify each new one in a sentence when you add it.
- Comment the sync clock and LRC parser thoroughly — they're the subtle parts.
- Small commits per feature with clear messages.
