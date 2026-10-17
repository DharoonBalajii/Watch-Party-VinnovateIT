// One interface over the two kinds of player the room can drive: a plain <video>
// (catalog films and pasted file links) and the YouTube IFrame player.

export type MediaEvent = 'buffering' | 'playing' | 'ready' | 'ended' | 'error';

export interface MediaHandle {
  readonly kind: 'video' | 'youtube';
  /** false = playbackRate can't be varied smoothly, so drift is fixed by seeking only */
  readonly canNudge: boolean;
  /** how far ahead of the target to land a hard seek (resuming after a seek costs time) */
  readonly seekLead: number;
  time(): number;
  seek(t: number): void;
  isPaused(): boolean;
  play(): Promise<void>;
  pause(): void;
  rate(): number;
  setRate(r: number): void;
  /** seconds, NaN while unknown */
  duration(): number;
  /** has metadata, so seeking works */
  hasMetadata(): boolean;
  /** enough data to play right now */
  canPlayNow(): boolean;
  isBuffering(): boolean;
  isEnded(): boolean;
  setVolume(v: number, muted: boolean): void;
  on(f: (e: MediaEvent) => void): () => void;
}

export class VideoHandle implements MediaHandle {
  readonly kind = 'video';
  readonly canNudge = true;
  readonly seekLead = 0.04;
  constructor(private v: HTMLVideoElement) {}
  time() { return this.v.currentTime; }
  seek(t: number) { this.v.currentTime = t; }
  isPaused() { return this.v.paused; }
  play() { return this.v.play(); }
  pause() { this.v.pause(); }
  rate() { return this.v.playbackRate; }
  setRate(r: number) { this.v.playbackRate = r; }
  duration() { return Number.isFinite(this.v.duration) && this.v.duration > 0 ? this.v.duration : NaN; }
  hasMetadata() { return this.v.readyState > 0; }
  canPlayNow() { return this.v.readyState >= 3; }
  isBuffering() {
    const v = this.v;
    return !v.paused ? v.readyState < 3 : v.readyState < 2 && !!v.currentSrc;
  }
  isEnded() { return this.v.ended; }
  setVolume(vol: number, muted: boolean) { this.v.volume = vol; this.v.muted = muted; }
  on(f: (e: MediaEvent) => void) {
    const map: [keyof HTMLMediaElementEventMap, MediaEvent][] = [
      ['waiting', 'buffering'], ['stalled', 'buffering'], ['seeked', 'buffering'],
      ['playing', 'playing'], ['canplay', 'ready'], ['loadedmetadata', 'ready'],
      ['ended', 'ended'], ['error', 'error'],
    ];
    const hs = map.map(([dom, ev]) => { const h = () => f(ev); this.v.addEventListener(dom, h); return [dom, h] as const; });
    return () => hs.forEach(([dom, h]) => this.v.removeEventListener(dom, h));
  }
}

// ───────── YouTube ─────────

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(s: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getPlaybackRate(): number;
  setPlaybackRate(r: number): void;
  setVolume(v: number): void;
  mute(): void;
  unMute(): void;
  cueVideoById(id: string): void;
  getPlaybackQuality(): string;
  destroy(): void;
}
interface YTNamespace {
  Player: new (el: HTMLElement, opts: unknown) => YTPlayer;
}
declare global {
  interface Window { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void }
}

const S = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

let apiPromise: Promise<YTNamespace> | null = null;
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT!); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => { apiPromise = null; reject(new Error('YouTube player failed to load')); };
    document.head.appendChild(s);
  });
  return apiPromise;
}

export class YouTubeHandle implements MediaHandle {
  readonly kind = 'youtube';
  readonly canNudge = false;
  readonly seekLead = 0.25;
  private state: number = S.UNSTARTED;
  private listeners = new Set<(e: MediaEvent) => void>();
  private pending: Promise<void> | null = null;
  private constructor(private p: YTPlayer, readonly ytId: string) {}

  /** builds the iframe inside `host` and resolves once the player answers */
  static async create(host: HTMLElement, ytId: string): Promise<YouTubeHandle> {
    const YT = await loadYouTubeApi();
    const mount = document.createElement('div');
    host.replaceChildren(mount);
    return new Promise((resolve) => {
      let handle: YouTubeHandle | null = null;
      const player = new YT.Player(mount, {
        videoId: ytId,
        width: '100%',
        height: '100%',
        playerVars: { controls: 0, disablekb: 1, fs: 0, rel: 0, playsinline: 1, iv_load_policy: 3, modestbranding: 1, origin: location.origin },
        events: {
          onReady: () => { handle = new YouTubeHandle(player, ytId); resolve(handle); handle.emit('ready'); },
          onStateChange: (e: { data: number }) => handle?.onState(e.data),
          onError: () => handle?.emit('error'),
        },
      });
    });
  }

  private emit(e: MediaEvent) { this.listeners.forEach((f) => f(e)); }
  private onState(s: number) {
    this.state = s;
    if (s === S.PLAYING) this.emit('playing');
    else if (s === S.BUFFERING) this.emit('buffering');
    else if (s === S.ENDED) this.emit('ended');
    else this.emit('ready');
  }

  time() { return this.p.getCurrentTime() || 0; }
  seek(t: number) { this.p.seekTo(t, true); }
  isPaused() { return this.state !== S.PLAYING && this.state !== S.BUFFERING; }
  /** resolves when playback starts; rejects like HTMLMediaElement when the browser blocks autoplay */
  play() {
    if (this.pending) return this.pending;
    this.p.playVideo();
    const p = new Promise<void>((resolve, reject) => {
      const check = (n: number) => {
        if (this.pending !== p) return resolve(); // paused or superseded
        if (this.state === S.PLAYING) return resolve();
        // first load can sit in BUFFERING for a while; a blocked autoplay never leaves UNSTARTED/PAUSED
        if (this.state === S.BUFFERING ? n >= 80 : n >= 15) return reject(new DOMException('YouTube did not start', 'NotAllowedError'));
        setTimeout(() => check(n + 1), 100);
      };
      setTimeout(() => check(0), 100); // after `this.pending` is assigned below
    }).finally(() => { if (this.pending === p) this.pending = null; });
    this.pending = p;
    return p;
  }
  pause() { this.pending = null; this.p.pauseVideo(); }
  rate() { return this.p.getPlaybackRate() || 1; }
  setRate(r: number) { if (r === 1) this.p.setPlaybackRate(1); }
  duration() { const d = this.p.getDuration(); return d > 0 ? d : NaN; }
  hasMetadata() { return this.p.getDuration() > 0; }
  canPlayNow() { return this.state !== S.BUFFERING && this.state !== S.UNSTARTED; }
  isBuffering() { return this.state === S.BUFFERING; }
  isEnded() { return this.state === S.ENDED; }
  setVolume(v: number, muted: boolean) {
    this.p.setVolume(Math.round(v * 100));
    if (muted) this.p.mute(); else this.p.unMute();
  }
  /** what YouTube is actually streaming right now, e.g. "hd720" */
  quality(): string { try { return this.p.getPlaybackQuality(); } catch { return ''; } }

  on(f: (e: MediaEvent) => void) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }
  destroy() { this.listeners.clear(); try { this.p.destroy(); } catch { /* iframe already gone */ } }
}
