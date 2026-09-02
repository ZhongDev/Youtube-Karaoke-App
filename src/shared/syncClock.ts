// Sync clock (SPEC.md §3) — the core of lyric timing.
//
// player.getCurrentTime() only refreshes every ~250ms, so driving the
// highlight straight off polls looks jerky. Instead the renderer feeds each
// poll into this clock and reads a smooth estimate every animation frame:
//
//   estimate = lastPolledTime + (wall now − poll wall time) × playbackRate
//
// while playing; frozen at the last polled time while paused or buffering.
// Each poll simply adopts the polled value (the spec's "keep it simple first"
// branch — the ≤250ms correction is invisible at lyric-line granularity), and
// a poll that disagrees with the estimate by more than SEEK_THRESHOLD_S is
// reported as a seek so callers can skip transition animations.
//
// Wall-clock milliseconds (performance.now()) are always passed in, never
// read internally, so the logic is pure and unit-testable with fake times.

export const SEEK_THRESHOLD_S = 0.35;

export class SyncClock {
  private polledTimeS = 0;
  private polledWallMs: number | null = null;
  private rate = 1;
  private playing = false;

  /** Feed a getCurrentTime() sample. Returns true if it looked like a seek. */
  poll(timeS: number, wallMs: number, rate: number, playing: boolean): boolean {
    const wasSeek =
      this.polledWallMs !== null &&
      Math.abs(timeS - this.timeS(wallMs)) > SEEK_THRESHOLD_S;
    this.polledTimeS = timeS;
    this.polledWallMs = wallMs;
    this.rate = rate;
    this.playing = playing;
    return wasSeek;
  }

  /** Estimated playback position in seconds at the given wall time. */
  timeS(wallMs: number): number {
    if (this.polledWallMs === null) return 0;
    if (!this.playing) return this.polledTimeS;
    return this.polledTimeS + ((wallMs - this.polledWallMs) / 1000) * this.rate;
  }

  reset(): void {
    this.polledTimeS = 0;
    this.polledWallMs = null;
    this.rate = 1;
    this.playing = false;
  }
}
