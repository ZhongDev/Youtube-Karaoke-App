// Loads the official YouTube IFrame Player API script once and resolves with
// the global `YT` namespace. Types come from @types/youtube (ambient `YT`).

declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
    YT?: typeof YT;
  }
}

let apiPromise: Promise<typeof YT> | null = null;

export function loadYouTubeApi(): Promise<typeof YT> {
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<typeof YT>((resolve, reject) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }

    window.onYouTubeIframeAPIReady = () => {
      if (window.YT) resolve(window.YT);
      else reject(new Error('YT namespace missing after API ready callback'));
    };

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => {
      apiPromise = null;
      reject(new Error('Failed to load YouTube IFrame API (offline?)'));
    };
    document.head.appendChild(script);
  });

  return apiPromise;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.0';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** "3:45" for a duration in seconds; '' when unknown. */
export function formatDuration(s: number | null): string {
  if (s === null || !Number.isFinite(s) || s <= 0) return '';
  const t = Math.round(s);
  const m = Math.floor(t / 60);
  return `${m}:${String(t - m * 60).padStart(2, '0')}`;
}

/** 1.6B / 297M / 84K style view counts. */
export function formatViews(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${n >= 1e7 ? Math.round(n / 1e6) : (n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}
