// Tiny token-bucket rate limiter, one instance per member.

interface Bucket {
  rate: number; // tokens per second
  burst: number;
  tokens: number;
  last: number;
}

const DEFAULTS = {
  chat: { rate: 1.2, burst: 6 },
  react: { rate: 8, burst: 14 },
  control: { rate: 6, burst: 12 },
  report: { rate: 4, burst: 8 },
  typing: { rate: 1, burst: 2 },
  ping: { rate: 6, burst: 20 },
  // WebRTC signaling: an offer/answer plus a burst of ICE candidates per peer
  rtc: { rate: 40, burst: 120 },
  other: { rate: 4, burst: 10 },
} as const;

export type LimitKind = keyof typeof DEFAULTS;

export class RateLimiter {
  private buckets = new Map<LimitKind, Bucket>();
  constructor(private now: () => number) {}

  allow(kind: LimitKind): boolean {
    const cfg = DEFAULTS[kind];
    const t = this.now();
    let b = this.buckets.get(kind);
    if (!b) {
      b = { rate: cfg.rate, burst: cfg.burst, tokens: cfg.burst, last: t };
      this.buckets.set(kind, b);
    }
    b.tokens = Math.min(b.burst, b.tokens + ((t - b.last) / 1000) * b.rate);
    b.last = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
