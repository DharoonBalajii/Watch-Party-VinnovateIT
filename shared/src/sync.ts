// Pure sync math shared by server, client and tests.
import type { PlaybackState } from './protocol';

/** Where the room's playhead is at server time `serverNow`. */
export function expectedPosition(state: PlaybackState, serverNow: number, duration?: number): number {
  let pos = state.anchorPos;
  if (state.status === 'playing') {
    pos += Math.max(0, serverNow - state.anchorServerTime) / 1000;
  }
  if (duration !== undefined && Number.isFinite(duration)) pos = Math.min(pos, duration);
  return Math.max(0, pos);
}

/** True while a scheduled start (play lead / countdown) is still in the future. */
export function isPendingStart(state: PlaybackState, serverNow: number): boolean {
  return state.status === 'playing' && serverNow < state.anchorServerTime;
}

export const DRIFT = {
  /** below this we leave the player alone (play-start latency alone is ~50–90 ms) */
  DEADBAND_S: 0.05,
  /** at or above this we hard-seek instead of nudging playbackRate */
  HARD_SEEK_S: 0.4,
  /** max playbackRate deviation while nudging */
  MAX_RATE_DELTA: 0.12,
  /** don't hard-seek again within this window (prevents seek storms on slow clients) */
  SEEK_COOLDOWN_MS: 1500,
} as const;

export type Correction =
  | { mode: 'sync'; rate: 1 }
  | { mode: 'nudge'; rate: number }
  | { mode: 'seek'; rate: 1; to: number };

/**
 * Decide how to fix `drift` (seconds, + = ahead of the room).
 * `target` is the position the player should be at right now.
 */
export function planCorrection(drift: number, target: number, canSeek: boolean): Correction {
  const abs = Math.abs(drift);
  if (abs < DRIFT.DEADBAND_S) return { mode: 'sync', rate: 1 };
  if (abs >= DRIFT.HARD_SEEK_S && canSeek) return { mode: 'seek', rate: 1, to: target };
  // proportional nudge: 100% of drift closed in ~1/0.5 s, capped
  const delta = Math.min(DRIFT.MAX_RATE_DELTA, Math.max(0.03, abs * 0.5));
  return { mode: 'nudge', rate: 1 + (drift > 0 ? -delta : delta) };
}

/**
 * NTP-style offset estimate. Each sample: {rtt, offset}. We keep the lowest-RTT
 * samples (least queueing noise) and take their median offset.
 */
export interface ClockSample {
  rtt: number;
  offset: number;
}
export function estimateOffset(samples: ClockSample[], keep = 5): { offset: number; rtt: number } | null {
  if (!samples.length) return null;
  const best = [...samples].sort((a, b) => a.rtt - b.rtt).slice(0, keep);
  const offsets = best.map((s) => s.offset).sort((a, b) => a - b);
  const mid = Math.floor(offsets.length / 2);
  const offset = offsets.length % 2 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2;
  return { offset, rtt: best[0].rtt };
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
