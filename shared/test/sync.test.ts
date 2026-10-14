import { describe, expect, it } from 'vitest';
import { DRIFT, estimateOffset, expectedPosition, isPendingStart, percentile, planCorrection } from '../src/sync';
import type { PlaybackState } from '../src/protocol';

const st = (over: Partial<PlaybackState> = {}): PlaybackState => ({
  videoId: 'x', status: 'playing', anchorPos: 10, anchorServerTime: 1000, seq: 1, ...over,
});

describe('expectedPosition', () => {
  it('advances in real time while playing', () => {
    expect(expectedPosition(st(), 3500)).toBeCloseTo(12.5);
  });
  it('stays put while paused', () => {
    expect(expectedPosition(st({ status: 'paused' }), 99999)).toBe(10);
  });
  it('holds at anchor until a scheduled start arrives', () => {
    const s = st({ anchorServerTime: 5000 });
    expect(expectedPosition(s, 4000)).toBe(10);
    expect(isPendingStart(s, 4000)).toBe(true);
    expect(expectedPosition(s, 6000)).toBeCloseTo(11);
    expect(isPendingStart(s, 6000)).toBe(false);
  });
  it('clamps to duration and zero', () => {
    expect(expectedPosition(st(), 1e9, 60)).toBe(60);
    expect(expectedPosition(st({ anchorPos: -5, status: 'paused' }), 0)).toBe(0);
  });
});

describe('planCorrection', () => {
  it('ignores drift inside the deadband', () => {
    expect(planCorrection(0.04, 10, true).mode).toBe('sync');
    expect(planCorrection(-DRIFT.DEADBAND_S + 0.001, 10, true).mode).toBe('sync');
  });
  it('nudges playbackRate for small drift, in the right direction', () => {
    const ahead = planCorrection(0.2, 10, true);
    const behind = planCorrection(-0.2, 10, true);
    expect(ahead.mode).toBe('nudge');
    expect(ahead.rate).toBeLessThan(1);
    expect(behind.rate).toBeGreaterThan(1);
    expect(Math.abs(ahead.rate - 1)).toBeLessThanOrEqual(DRIFT.MAX_RATE_DELTA);
  });
  it('hard-seeks past the threshold', () => {
    const c = planCorrection(0.9, 42, true);
    expect(c).toEqual({ mode: 'seek', rate: 1, to: 42 });
  });
  it('falls back to a nudge while a seek is on cooldown', () => {
    expect(planCorrection(0.9, 42, false).mode).toBe('nudge');
  });
});

describe('clock estimation', () => {
  it('prefers low-RTT samples and rejects outliers', () => {
    const samples = [
      { rtt: 400, offset: 250 }, // congested sample, wrong offset
      { rtt: 8, offset: 101 },
      { rtt: 6, offset: 100 },
      { rtt: 9, offset: 99 },
      { rtt: 7, offset: 100 },
      { rtt: 12, offset: 102 },
      { rtt: 300, offset: -80 },
    ];
    const est = estimateOffset(samples)!;
    expect(est.offset).toBeGreaterThanOrEqual(99);
    expect(est.offset).toBeLessThanOrEqual(101);
    expect(est.rtt).toBe(6);
  });
  it('returns null with no samples', () => expect(estimateOffset([])).toBeNull());
});

describe('percentile', () => {
  it('computes nearest-rank percentiles', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 99)).toBe(99);
  });
});
