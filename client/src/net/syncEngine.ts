import { DRIFT, expectedPosition, planCorrection } from '@shared/sync';
import { getClient } from './client';
import type { MediaHandle } from './media';
import { selectSource, useRoom } from '../store';

/**
 * Keeps the room's player locked to the authoritative playback anchor.
 *  - paused → park on the anchor position
 *  - playing → start at the scheduled instant, then every tick:
 *      |drift| < 50 ms   leave alone
 *      < 400 ms          nudge playbackRate (±3–12 %), no visible jump
 *      ≥ 400 ms          hard seek (1.5 s cooldown so a slow client can't seek-storm)
 *    YouTube can't vary its rate smoothly, so there it only seeks, past 350 ms.
 */
export class SyncEngine {
  private timer = 0;
  private startTimer = 0;
  private lastSeekAt = 0;
  private lastBuffering = false;
  private corrections = 0;
  private seeks = 0;
  private lastMode: 'sync' | 'nudge' | 'seek' | 'idle' = 'idle';
  private cleanups: (() => void)[] = [];
  private media: MediaHandle | null = null;
  /** a freshly built player's first load is ours alone: don't make the room hold for it */
  private quietUntil = 0;
  private detach: (() => void) | null = null;

  constructor() {
    const vis = () => { if (!document.hidden) this.tick(); };
    document.addEventListener('visibilitychange', vis);
    this.cleanups.push(() => document.removeEventListener('visibilitychange', vis));
    this.timer = window.setInterval(() => this.tick(), 250);
  }

  /** point the engine at a player (or none while a new one is being built) */
  attach(media: MediaHandle | null) {
    this.detach?.();
    this.detach = null;
    this.media = media;
    this.lastBuffering = false;
    if (!media) return;
    this.quietUntil = Date.now() + 6000;
    this.detach = media.on((e) => {
      if (e === 'ended') {
        const id = useRoom.getState().state.videoId;
        if (id) getClient()?.send({ t: 'ended', videoId: id });
        return;
      }
      if (e === 'error') {
        const src = selectSource(useRoom.getState());
        if (src && src.kind !== 'catalog') useRoom.getState().toast(src.kind === 'youtube' ? 'YouTube won’t play this video here. The owner may have turned off embedding.' : 'That link didn’t load. It must point straight at a video file (.mp4 or .webm).', 'error');
        return;
      }
      if (e === 'playing') useRoom.getState().set({ engine: { ...useRoom.getState().engine, needsGesture: false } });
      this.syncBuffering();
      if (e === 'ready') this.tick();
    });
    this.onState();
  }

  destroy() {
    this.detach?.();
    window.clearInterval(this.timer);
    window.clearTimeout(this.startTimer);
    this.cleanups.forEach((f) => f());
  }

  /** this viewer's player position in seconds (null with no player) */
  time(): number | null { return this.media ? this.media.time() : null; }
  /** YouTube's current streaming quality, when a YouTube video is up */
  ytQuality(): string | null {
    const m = this.media;
    return m?.kind === 'youtube' ? (m as unknown as { quality(): string }).quality() || null : null;
  }

  /** call when a new playback state arrives so we react immediately (and schedule synced starts) */
  onState() {
    window.clearTimeout(this.startTimer);
    const client = getClient();
    const { state } = useRoom.getState();
    if (client && state.status === 'playing') {
      const wait = state.anchorServerTime - client.serverNow();
      if (wait > 0) this.startTimer = window.setTimeout(() => this.tick(), Math.max(0, wait - 4));
    }
    this.tick();
  }

  async play() {
    if (!this.media) return;
    try {
      await this.media.play();
      useRoom.getState().set({ engine: { ...useRoom.getState().engine, needsGesture: false } });
    } catch (e) {
      if ((e as DOMException)?.name === 'NotAllowedError') {
        useRoom.getState().set({ engine: { ...useRoom.getState().engine, needsGesture: true } });
      }
    }
  }

  private syncBuffering() {
    if (!this.media) return;
    const buffering = this.media.isBuffering() && Date.now() > this.quietUntil;
    if (buffering !== this.lastBuffering) {
      this.lastBuffering = buffering;
      useRoom.getState().set({ engine: { ...useRoom.getState().engine, buffering } });
      this.reportNow();
    }
  }

  reportNow() {
    const client = getClient();
    const r = client?.getReport?.();
    if (client && r) client.send({ t: 'report', ...r, rtt: useRoom.getState().rtt });
  }

  tick() {
    const client = getClient();
    const store = useRoom.getState();
    const { state } = store;
    const v = this.media;
    if (!client || !v || !state.videoId || store.status === 'failed') return;
    const src = selectSource(store);
    if (!src) return;
    if (this.lastBuffering !== (v.isBuffering() && Date.now() > this.quietUntil)) this.syncBuffering();

    const now = client.serverNow();
    const known = v.duration();
    const dur = Number.isFinite(known) ? known : src.runtime || Infinity;
    const exp = expectedPosition(state, now, Number.isFinite(dur) ? dur : undefined);
    // a screen share takes over the stage: keep the film parked underneath
    const wantPlay = state.status === 'playing' && !store.share && now >= state.anchorServerTime && !(v.isEnded() && exp >= dur - 0.2);
    const cur = v.time();
    let mode: 'sync' | 'nudge' | 'seek' | 'idle' = 'idle';
    let drift = cur - exp;

    if (!wantPlay) {
      if (!v.isPaused()) v.pause();
      if (v.rate() !== 1) v.setRate(1);
      if (Math.abs(drift) > (v.canNudge ? 0.06 : 0.3) && v.hasMetadata()) v.seek(exp);
      drift = 0;
    } else {
      if (v.isPaused()) void this.play();
      if (!v.canPlayNow()) {
        mode = 'idle';
      } else {
        const cooldown = v.canNudge ? DRIFT.SEEK_COOLDOWN_MS : DRIFT.SEEK_ONLY_COOLDOWN_MS;
        const canSeek = Date.now() - this.lastSeekAt > cooldown;
        const plan = planCorrection(drift, exp, canSeek, v.canNudge);
        mode = plan.mode;
        if (plan.mode === 'seek') {
          v.seek(plan.to + v.seekLead); // land slightly ahead: play-resume costs a few ms
          v.setRate(1);
          this.lastSeekAt = Date.now();
          this.seeks++;
          this.corrections++;
        } else if (plan.mode === 'nudge') {
          if (Math.abs(v.rate() - plan.rate) > 0.005) v.setRate(plan.rate);
          if (this.lastMode !== 'nudge') this.corrections++;
        } else if (v.rate() !== 1) {
          v.setRate(1);
        }
      }
    }
    this.lastMode = mode;

    const prev = store.engine;
    const next = {
      ...prev, drift, mode, pos: v.time(), duration: Number.isFinite(dur) ? dur : 0, buffering: this.lastBuffering,
      corrections: this.corrections, seeks: this.seeks,
    };
    if (
      Math.abs(next.pos - prev.pos) > 0.2 || next.mode !== prev.mode || Math.abs(next.drift - prev.drift) > 0.01 ||
      next.buffering !== prev.buffering || next.duration !== prev.duration || next.corrections !== prev.corrections
    ) {
      useRoom.getState().set({ engine: next });
    }
    // expose for tests / debugging
    (window as any).__wp = { drift, mode, pos: v.time(), exp, rate: v.rate(), paused: v.isPaused(), seeks: this.seeks, state, kind: v.kind };
  }
}
