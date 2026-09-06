# YouTube Karaoke

A personal-use desktop karaoke app for macOS. It plays YouTube videos through the
official IFrame player and overlays time-synced lyrics in a Joysound-style
two-lane display, with a persistent queue, a library of everything you have
played, per-video sync offsets, and a fully local lyrics pipeline that never
needs an API key or a paid service.

Built with Electron Forge + Vite, React 19 and TypeScript (strict), SQLite
(better-sqlite3) for the cache, and an optional Python worker (managed by uv)
for local Whisper/Demucs jobs. See `SPEC.md` for the original build spec.

## Features

- **Playback** via the YouTube IFrame API. Videos that block embedding are
  detected and the app offers (and after 5 s switches to) the auto-generated
  "Artist - Topic" upload of the same song, whose studio audio syncs best.
- **Lyrics, three tiers, all free:**
  1. synced lyrics from **LRCLIB** and **NetEase Cloud Music** (original-script
     search for Japanese/Korean, ranked by title/artist similarity and
     duration);
  2. plain lyrics shown in an unsynced scroll box, plus a manual paste box for
     lyrics or LRC from anywhere;
  3. **local audio jobs** (Whisper + Demucs on this Mac): *Align lyrics* turns
     any stored text into word-synced lyrics, *Transcribe from audio* writes
     lyrics when none exist anywhere, and *Auto-offset* measures how much
     longer a music video's intro is than the recording the lyrics were timed
     to. Jobs run in the background; playback keeps working.
- **Two-track display** (default): two fixed lanes in the bottom 40 % of the
  video, lines fade in early and are highlighted with a left-to-right wipe,
  word-accurate when the lyrics are word-synced. A classic previous / current /
  next **scroll display** is available in Settings.
- **Reading aids:** furigana (kana over kanji) or romaji over Japanese lyrics,
  Revised Romanization over Korean lyrics — computed once per song with
  kuromoji and cached.
- **Search** YouTube by typing a song name (yt-dlp, no API key) or paste a
  URL / video id; results show duration, views and Topic-upload badges.
- **Queue** with play-next / add-to-end, drag reorder, per-song lyric-state
  badges, auto-advance; survives restarts.
- **Library:** every cached song as playlists — Recently played, Most played,
  All songs, and your own playlists (create, rename, reorder, queue all).
- **Sync offset** per video: hotkeys, or click the offset chip for a slider,
  exact millisecond entry, reset and auto-offset. Persisted immediately.
- **Lyrics inspector:** raw LRC per source, switch the active source, edit
  artist/track (re-fetches), re-fetch, manual paste, and the local jobs.
- **TV mode:** fullscreen on any display with only video, lyrics and a
  next-up strip; the pointer hides itself.
- **Metadata** from YouTube oEmbed plus a heuristic title parser that handles
  EN/JP/KR title conventions; an optional local Ollama model can assist on
  hard titles. Everything is user-editable.

## Requirements

- macOS on Apple Silicon (primary target; Intel Macs run everything on CPU).
- Node.js 20 or newer and npm.
- An internet connection for YouTube and the lyrics providers. Nothing else
  is required up front — yt-dlp, uv, Python and the ML models are downloaded
  on demand from Settings (see *First-run setup*).

## Install and run

```sh
git clone <this repo>
cd "Youtube Karaoke App"
npm install
npm start          # dev: Vite dev server + Electron, with DevTools detached
```

Other scripts:

```sh
npm test           # vitest — parsers, sync clock, scheduler, romanization, …
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run package    # unpacked app under out/YouTube Karaoke-darwin-arm64/
npm run make       # distributable zip under out/make/
```

`npm run package` bundles the renderer and main process with Vite, copies the
runtime-external packages (better-sqlite3 and kuromoji with its dictionary)
into the app, and ships the Python worker (`worker/`) beside the app bundle.
The packaged app serves its renderer from a local HTTP server because
YouTube's embed refuses custom-scheme and `127.0.0.1` origins.

## First-run setup

The app works for playback and provider lyrics straight away. The optional
tools are one-click downloads in **Settings** and land in the app's data
folder, never system-wide:

| Feature | What is needed | Where to get it |
| --- | --- | --- |
| YouTube search, Topic-upload suggestions | yt-dlp (~50 MB) | Settings → Search → *Download app-managed yt-dlp* (or point it at your own binary) |
| Local audio jobs | uv (~35 MB), then a private Python 3.12 + torch/Demucs/Whisper environment (~700 MB) | Settings → Local audio jobs → *Download app-managed uv*, then *Prepare Python environment* (the first job does this too) |
| Whisper model weights | 0.5–3 GB depending on the model | Downloaded automatically into `~/.cache/whisper` on first use; Demucs weights go to the torch hub cache |

Whisper model and compute device are chosen in the same settings section
(`large-v3` by default; `medium`/`small` are faster). Demucs runs on the
Apple GPU, Whisper on the CPU.

## Using it

1. Type a song name in the search box and press Enter (or paste a YouTube
   URL). Pick a result: Enter queues it, Shift+Enter plays it next. Prefer
   "Topic" uploads when offered — they sync best.
2. Lyrics are fetched and cached the first time a song is queued. The badge in
   the top bar shows what was found (word-synced / line-synced / plain / none)
   and which source it came from; click it for the inspector.
3. If the lyrics run early or late, nudge the offset or click the offset chip
   in the status bar. When the video is a different length from the recording
   the lyrics were timed for, the status bar warns and offers *Use Topic
   upload* and *Auto-offset*.
4. For songs with only plain lyrics, open the inspector and run *Align
   lyrics*; for songs with none, *Transcribe from audio*.
5. Press `t` for TV mode on the current display, or use the TV button's menu
   to pick another display.

### Hotkeys

| Key | Action |
| --- | --- |
| `Space` | play / pause |
| `[` / `]` | offset −/+ 100 ms |
| `{` / `}` | offset −/+ 500 ms |
| `\` | reset offset to 0 |
| `i` | lyrics inspector |
| `l` | library |
| `t` | toggle TV mode |
| `Esc` | close popover / modal, leave TV mode |

Hotkeys keep working after clicking the video: focus is pulled back out of the
YouTube frame.

## Where things live

Everything is under `~/Library/Application Support/YouTube Karaoke/`:

| Path | Contents |
| --- | --- |
| `karaoke.db` | SQLite cache: tracks, lyrics (one row per source), offsets, queue, plays, playlists, reading-aid cache, settings |
| `yt-dlp/current/` | app-managed yt-dlp |
| `uv/current/`, `align-venv/` | app-managed uv and the worker's Python environment |

Whisper weights: `~/.cache/whisper`. Temporary audio for jobs is decoded under
the system temp folder and removed when the job finishes.

Set `KARAOKE_USER_DATA=/some/dir` to run a second instance on its own data
folder (handy for testing without touching your queue).

## Project layout

```
src/shared/     pure, unit-tested logic shared by both processes: IPC contract
                (ipc.ts), LRC parser, sync clock, two-track scheduler, title
                parser, language detection, romanization (ruby.ts), auto-offset
                estimator, search/Topic ranking, library helpers
src/main/       Electron main: SQLite + migrations (db.ts, repo.ts), lyrics
                providers, metadata resolver, queue / library / lyrics / ruby /
                alignment services, yt-dlp and uv managers, IPC handlers
src/preload/    contextBridge exposing the typed `window.karaoke` API
src/renderer/   React UI: player, two-track and scroll lyrics, queue, search,
                library, inspector, settings, TV mode
worker/         Python worker (align.py + uv project): yt-dlp → ffmpeg →
                Demucs → stable-ts, driven over stdin/stdout NDJSON
```

Conventions: TypeScript strict everywhere, no `any` across the IPC boundary
(all shapes in `src/shared/ipc.ts`), all network and child processes in the
main process, parsers and timing logic as pure modules with tests.

## Debugging

- `npm start -- -- --remote-debugging-port=9225` exposes the renderer over the
  Chrome DevTools Protocol for scripted checks.
- The main-process log (the terminal running `npm start`) prefixes lines by
  subsystem: `[lyrics]`, `[queue]`, `[align]`, `[ruby]`, `[settings]`.
- Provider results, offsets and the queue can be inspected with `sqlite3` on
  `karaoke.db`; the schema is versioned in `src/main/db.ts`.

## Non-goals

No accounts or cloud sync, no audio downloading for playback (playback is
always the official embed), no Windows/Linux packaging for now, and no paid
lyrics APIs.
