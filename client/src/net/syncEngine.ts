import { DRIFT, expectedPosition, planCorrection } from '@shared/sync';
import { CATALOG_BY_ID } from '@shared/catalog';
import { getClient } from './client';
import { useRoom } from '../store';

/**
 * Keeps a <video> locked to the room's authoritative playback anchor.
 *  - paused → park on the anchor position
 *  - playing → start at the scheduled instant, then every tick:
 *      |drift| < 50 ms   leave alone
 *      < 400 ms          nudge playbackRate (±3–12 %), no visible jump
 *      ≥ 400 ms          hard seek (1.5 s cooldown so a slow client can't seek-storm)
 */
export class SyncEngine {
  private timer = 0;
  private startTimer = 0;
  private lastSeekAt = 0;
  private lastBuffering = false;
  private videoId: string | null = null;
  private corrections = 0;
  private seeks = 0;
  private lastMode: 'sync' | 'nudge' | 'seek' | 'idle' = 'idle';
  private cleanups: (() => void)[] = [];

  constructor(private video: HTMLVideoElement) {
    const on = (t: keyof HTMLMediaElementEventMap, f: () => void) => {
      video.addEventListener(t, f);
      this.cleanups.push(() => video.removeEventListener(t, f));
    };
    on('waiting', () => this.syncBuffering());
    on('stalled', () => this.syncBuffering());
    on('playing', () => { this.syncBuffering(); useRoom.getState().set({ engine: { ...useRoom.getState().engine, needsGesture: false } }); });
    on('canplay', () => { this.syncBuffering(); this.tick(); });
    on('loadedmetadata', () => this.tick());
    on('seeked', () => this.syncBuffering());
    on('ended', () => {
      const id = useRoom.getState().state.videoId;
      if (id) getClient()?.send({ t: 'ended', videoId: id });
    });
    const vis = () => { if (!document.hidden) this.tick(); };
    document.addEventListener('visibilitychange', vis);
    this.cleanups.push(() => document.removeEventListener('visibilitychange', vis));
    this.timer = window.setInterval(() => this.tick(), 250);
  }

  destroy() {
    window.clearInterval(this.timer);
    window.clearTimeout(this.startTimer);
    this.cleanups.forEach((f) => f());
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
    try {
      await this.video.play();
      useRoom.getState().set({ engine: { ...useRoom.getState().engine, needsGesture: false } });
    } catch (e) {
      if ((e as DOMException)?.name === 'NotAllowedError') {
        useRoom.getState().set({ engine: { ...useRoom.getState().engine, needsGesture: true } });
      }
    }
  }

  private syncBuffering() {
    const v = this.video;
    const buffering = !v.paused ? v.readyState < 3 : v.readyState < 2 && !!v.currentSrc;
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
    const v = this.video;
    if (!client || !state.videoId || store.status === 'failed') return;
    const movie = CATALOG_BY_ID[state.videoId];
    if (!movie) return;

    const now = client.serverNow();
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : movie.runtime;
    const exp = expectedPosition(state, now, dur);
    const wantPlay = state.status === 'playing' && now >= state.anchorServerTime && !(v.ended && exp >= dur - 0.2);
    const cur = v.currentTime;
    let mode: 'sync' | 'nudge' | 'seek' | 'idle' = 'idle';
    let drift = cur - exp;

    if (!wantPlay) {
      if (!v.paused) v.pause();
      if (v.playbackRate !== 1) v.playbackRate = 1;
      if (Math.abs(drift) > 0.06 && v.readyState > 0) v.currentTime = exp;
      drift = 0;
    } else {
      if (v.paused) void this.play();
      if (v.readyState < 3) {
        mode = 'idle';
      } else {
        const canSeek = Date.now() - this.lastSeekAt > DRIFT.SEEK_COOLDOWN_MS;
        const plan = planCorrection(drift, exp, canSeek);
        mode = plan.mode;
        if (plan.mode === 'seek') {
          v.currentTime = plan.to + 0.04; // land slightly ahead: play-resume costs a few ms
          v.playbackRate = 1;
          this.lastSeekAt = Date.now();
          this.seeks++;
          this.corrections++;
        } else if (plan.mode === 'nudge') {
          if (Math.abs(v.playbackRate - plan.rate) > 0.005) v.playbackRate = plan.rate;
          if (this.lastMode !== 'nudge') this.corrections++;
        } else if (v.playbackRate !== 1) {
          v.playbackRate = 1;
        }
      }
    }
    this.lastMode = mode;

    const prev = store.engine;
    const next = {
      ...prev, drift, mode, pos: v.currentTime, duration: dur, buffering: this.lastBuffering,
      corrections: this.corrections, seeks: this.seeks,
    };
    if (
      Math.abs(next.pos - prev.pos) > 0.2 || next.mode !== prev.mode || Math.abs(next.drift - prev.drift) > 0.01 ||
      next.buffering !== prev.buffering || next.duration !== prev.duration || next.corrections !== prev.corrections
    ) {
      useRoom.getState().set({ engine: next });
    }
    // expose for tests / debugging
    (window as any).__wp = { drift, mode, pos: v.currentTime, exp, rate: v.playbackRate, paused: v.paused, seeks: this.seeks, state };
  }
}
