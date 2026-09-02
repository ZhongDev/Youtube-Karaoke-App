import { useEffect, useRef, type RefObject } from 'react';
import type { SyncClock } from '../../shared/syncClock';
import { loadYouTubeApi } from '../youtube';

/** Imperative controls exposed to the parent via `handleRef`. */
export interface PlayerHandle {
  play(): void;
  pause(): void;
  toggle(): void;
}

export interface PlayerCallbacks {
  onReady(durationS: number): void;
  onStateChange(stateName: string, playing: boolean): void;
  /** Clock-estimated time, fired on each 250ms poll (drives the readout). */
  onTick(timeS: number, durationS: number): void;
  onEmbedBlocked(): void;
  onError(code: number): void;
}

interface PlayerProps extends PlayerCallbacks {
  videoId: string;
  clock: SyncClock;
  /** false = cue only (e.g. queue restored at launch); user starts it. */
  autoplay: boolean;
  handleRef: RefObject<PlayerHandle | null>;
}

const STATE_NAMES: Record<number, string> = {
  [-1]: 'unstarted',
  0: 'ended',
  1: 'playing',
  2: 'paused',
  3: 'buffering',
  5: 'cued',
};

/** YouTube IFrame player wired to the sync clock. Remount (key) per video. */
export default function Player(props: PlayerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  // Latest-props ref so the create-once effect can call fresh callbacks.
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const { videoId, clock, autoplay, handleRef } = propsRef.current;
    let cancelled = false;
    let player: YT.Player | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let playing = false;

    // The IFrame API replaces its target element, so give it a child div
    // instead of the React-managed node.
    const target = document.createElement('div');
    mount.appendChild(target);

    const poll = () => {
      if (!player) return;
      try {
        const now = performance.now();
        clock.poll(player.getCurrentTime(), now, player.getPlaybackRate(), playing);
        propsRef.current.onTick(clock.timeS(now), player.getDuration());
      } catch {
        // Player mid-teardown — ignore.
      }
    };

    loadYouTubeApi()
      .then((yt) => {
        if (cancelled) return;
        player = new yt.Player(target, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: { autoplay: autoplay ? 1 : 0, playsinline: 1, rel: 0 },
          events: {
            onReady: (e) => {
              propsRef.current.onReady(e.target.getDuration());
              pollTimer = setInterval(poll, 250);
            },
            onStateChange: (e) => {
              playing = e.data === 1;
              poll(); // freeze/unfreeze the clock immediately
              propsRef.current.onStateChange(
                STATE_NAMES[e.data] ?? `state ${e.data}`,
                playing,
              );
            },
            onError: (e) => {
              // 101/150 = embedding disabled by uploader (SPEC.md §8).
              if (e.data === 101 || e.data === 150) propsRef.current.onEmbedBlocked();
              else propsRef.current.onError(e.data);
            },
          },
        });
        handleRef.current = {
          play: () => player?.playVideo(),
          pause: () => player?.pauseVideo(),
          toggle: () => {
            if (!player) return;
            if (player.getPlayerState() === 1) player.pauseVideo();
            else player.playVideo();
          },
        };
      })
      .catch(() => {
        if (!cancelled) propsRef.current.onError(-1);
      });

    return () => {
      cancelled = true;
      handleRef.current = null;
      if (pollTimer) clearInterval(pollTimer);
      player?.destroy();
      player = null;
      target.remove();
    };
    // Recreated via key={videoId}; props flow through propsRef.
  }, []);

  return <div className="player-mount" ref={mountRef} />;
}
