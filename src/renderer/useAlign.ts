import { useEffect, useState } from 'react';
import type { AlignJob, AlignSnapshot, AlignStage } from '../shared/ipc';

// Renderer view of the main-owned alignment job list. Main pushes a full
// snapshot on every change (throttled); the initial alignGet() fills the
// gap until the first push.

const EMPTY: AlignSnapshot = { jobs: [] };

export function useAlign(): AlignSnapshot {
  const [snap, setSnap] = useState<AlignSnapshot>(EMPTY);
  useEffect(() => {
    let alive = true;
    const off = window.karaoke.onAlignChanged((s) => alive && setSnap(s));
    window.karaoke
      .alignGet()
      .then((s) => alive && setSnap((prev) => (prev === EMPTY ? s : prev)))
      .catch(console.error);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return snap;
}

export function isAlignActive(stage: AlignStage): boolean {
  return stage !== 'done' && stage !== 'error' && stage !== 'cancelled';
}

export const STAGE_LABEL: Record<AlignStage, string> = {
  queued: 'Queued',
  setup: 'Python environment',
  download: 'Downloading audio',
  decode: 'Decoding audio',
  separate: 'Isolating vocals',
  load: 'Loading Whisper',
  align: 'Aligning words',
  done: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled',
};

/** Rough whole-job progress: each stage owns a slice of the bar. */
const STAGE_SPAN: Partial<Record<AlignStage, [number, number]>> = {
  queued: [0, 0],
  setup: [0, 5],
  download: [5, 15],
  decode: [15, 18],
  separate: [18, 50],
  load: [50, 60],
  align: [60, 100],
};

export function overallPercent(job: AlignJob): number {
  if (job.stage === 'done') return 100;
  const span = STAGE_SPAN[job.stage];
  if (!span) return job.percent;
  return Math.round(span[0] + ((span[1] - span[0]) * job.percent) / 100);
}
