import { useEffect, useRef, useState } from 'react';
import { apiUrl, getClient } from '../net/client';
import { SyncEngine } from '../net/syncEngine';
import { VideoHandle, YouTubeHandle, type MediaHandle } from '../net/media';
import { togglePlay, startTogether } from '../net/controls';
import { selectCanControl, useCurrentSource, useRoom } from '../store';
import { cx, fmtTime } from '../util';
import { Countdown, ReadyCard } from './Countdown';
import { ScreenStage } from './ScreenStage';
import { Captions, CaptionsMenu, QualityMenu } from './StageMenus';
import type { YtQuality } from '../store';

/** the player size, in device pixels, that makes YouTube pick each quality (measured: a new
 * player streams one step above its own height, and YouTube won't drop below 480p) */
const YT_SIZE: Record<Exclude<YtQuality, 'auto'>, [number, number]> = {
  hd1080: [1920, 1080], hd720: [1280, 720], large: [640, 360],
};

let engineRef: SyncEngine | null = null;
export const getEngine = () => engineRef;

const loadVol = () => { try { return Number(localStorage.getItem('wp:vol') ?? '0.8'); } catch { return 0.8; } };

export function Player({ stageRef }: { stageRef: React.RefObject<HTMLElement | null> }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const ytHostRef = useRef<HTMLDivElement>(null);
  const stageRef2 = useRef<HTMLDivElement>(null);
  const ytQuality = useRoom((s) => s.ytQuality);
  const handleRef = useRef<MediaHandle | null>(null);
  const share = useRoom((s) => s.share);
  const status = useRoom((s) => s.state.status);
  const engine = useRoom((s) => s.engine);
  const holding = useRoom((s) => s.holding);
  const members = useRoom((s) => s.members);
  const health = useRoom((s) => s.health);
  const youId = useRoom((s) => s.youId);
  const ready = useRoom((s) => s.ready);
  const canControl = useRoom(selectCanControl);
  const movie = useCurrentSource();
  const [vol, setVol] = useState(loadVol);
  const [muted, setMuted] = useState(false);
  const [fs, setFs] = useState(false);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number>(0);

  // engine lifecycle
  useEffect(() => {
    const e = new SyncEngine();
    engineRef = e;
    const client = getClient();
    const onState = () => e.onState();
    client?.onState.push(onState);
    if (client) {
      client.getReport = () => {
        const s = useRoom.getState();
        return { pos: s.engine.pos, drift: s.engine.drift, mode: s.engine.mode, buffering: s.engine.buffering, duration: s.engine.duration || undefined };
      };
    }
    e.onState();
    return () => {
      e.destroy();
      engineRef = null;
      if (client) {
        client.onState = client.onState.filter((f) => f !== onState);
        client.getReport = null;
      }
    };
  }, []);

  // load the source when the room's video changes: a <video> for files, the IFrame player for YouTube
  // YouTube only lowers quality for a brand-new player, so a quality change rebuilds it (this viewer only)
  const sourceKey = movie ? `${movie.kind}:${movie.ytId ?? movie.url}${movie.kind === 'youtube' ? `:${ytQuality}` : ''}` : '';
  // YouTube chooses its quality from the player's pixel size, so render the iframe at the
  // chosen resolution and scale it to fit the stage
  useEffect(() => {
    const host = ytHostRef.current!;
    const stage = stageRef2.current!;
    const apply = () => {
      if (ytQuality === 'auto' || movie?.kind !== 'youtube') { host.removeAttribute('style'); return; }
      const dpr = window.devicePixelRatio || 1;
      const [w, h] = YT_SIZE[ytQuality].map((n) => n / dpr);
      const scale = Math.min(stage.clientWidth / w, stage.clientHeight / h);
      Object.assign(host.style, { inset: 'auto', left: '50%', top: '50%', width: `${w}px`, height: `${h}px`, transform: `translate(-50%, -50%) scale(${scale})` });
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [ytQuality, sourceKey, movie?.kind]);
  useEffect(() => {
    const v = videoRef.current!;
    const host = ytHostRef.current!;
    let cancelled = false;
    let yt: YouTubeHandle | null = null;
    const use = (h: MediaHandle | null) => {
      handleRef.current = h;
      (window as unknown as { __wpMedia: unknown }).__wpMedia = h; // tests / devtools
      h?.setVolume(loadVol(), false);
      engineRef?.attach(h);
    };
    if (!movie) {
      v.removeAttribute('src'); v.load();
      use(null);
    } else if (movie.kind === 'youtube') {
      v.removeAttribute('src'); v.load();
      use(null);
      YouTubeHandle.create(host, movie.ytId!)
        .then((h) => { if (cancelled) h.destroy(); else { yt = h; use(h); } })
        .catch(() => { if (!cancelled) useRoom.getState().toast('The YouTube player didn’t load. Check your connection or an ad blocker.', 'error'); });
    } else {
      v.src = movie.kind === 'upload' ? apiUrl(movie.url!) : movie.url!;
      v.load();
      use(new VideoHandle(v));
    }
    return () => {
      cancelled = true;
      yt?.destroy();
      host.replaceChildren();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);


  useEffect(() => {
    handleRef.current?.setVolume(vol, muted);
    try { localStorage.setItem('wp:vol', String(vol)); } catch { /* ignore */ }
  }, [vol, muted, sourceKey]);

  useEffect(() => {
    const on = () => setFs(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, [stageRef]);

  const wake = () => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2600);
  };
  useEffect(() => () => window.clearTimeout(idleTimer.current), []);

  const toggleFs = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stageRef.current?.requestFullscreen?.();
  };

  const joinScreening = async () => { await getEngine()?.play(); useRoom.getState().set({ engine: { ...useRoom.getState().engine, needsGesture: false } }); };

  const stragglers = members.filter((m) => health[m.id]?.buffering && m.connected && m.id !== youId);
  const atEnd = !!movie && !share && status === 'paused' && engine.duration > 0 && engine.pos >= engine.duration - 1.5;
  const controlsVisible = status === 'paused' || !idle || !movie || !!share;

  return (
    <div
      ref={stageRef2}
      className={cx('stage', controlsVisible && 'is-ui', fs && 'is-fs')}
      onPointerMove={wake}
      onPointerLeave={() => setIdle(status === 'playing')}
    >
      <video ref={videoRef} className={cx('stage__video', movie?.kind === 'youtube' && 'is-hidden')} playsInline preload="auto" onClick={() => movie && canControl && togglePlay()} />
      <div ref={ytHostRef} className={cx('stage__yt', movie?.kind !== 'youtube' && 'is-hidden')} />
      {/* YouTube's own UI would only play/pause this one viewer, so clicks land on the room's controls instead */}
      {movie?.kind === 'youtube' && <div className="stage__catch" onClick={() => canControl && togglePlay()} aria-hidden />}

      {share && <ScreenStage />}
      {movie && !share && <Captions />}

      {!movie && !share && (
        <div className="stage__empty">
          <div className="stage__curtain" aria-hidden />
          <p className="eyebrow">The screen is dark</p>
          <h2>Nothing’s showing yet</h2>
          <p>Pick a film, put on a YouTube video, upload your own, or share your screen. It goes up for everyone at once.</p>
          <div className="stage__empty-actions">
            <button className="btn btn--butter btn--lg" onClick={() => useRoom.getState().set({ discoverOpen: true })}>Find a movie</button>
            <button className="btn btn--line btn--lg" onClick={() => useRoom.getState().set({ discoverOpen: true, discoverMode: 'link' })}><YouTubeMark /> YouTube</button>
            <button className="btn btn--line btn--lg" onClick={() => useRoom.getState().set({ discoverOpen: true, discoverMode: 'upload' })}>Upload a video</button>
          </div>
        </div>
      )}

      {movie && !share && (
        <div className="stage__title">
          <b>{movie.title}</b>
          <span className="mono">{movie.label}{movie.silent ? ' · silent' : ''}</span>
        </div>
      )}

      {engine.buffering && movie && !share && !ready?.startAt && <div className="stage__spinner" role="status" aria-label="Buffering" />}

      {holding && (
        <div className="stage__banner" role="status">
          <span className="dot dot--amber" /> Holding for {stragglers.length ? stragglers.map((s) => s.name).join(', ') : 'someone'} to catch up
        </div>
      )}

      {engine.needsGesture && movie && !share && (
        <button className="stage__gesture" onClick={joinScreening}>
          <span className="stage__gesture-icon" aria-hidden>▶</span>
          <b>Tap to join the screening</b>
          <span>Your browser needs one tap before it will play with sound.</span>
        </button>
      )}

      {atEnd && (
        <div className="stage__end">
          <p className="eyebrow">That’s a wrap</p>
          <h2>{movie!.title}</h2>
          <button className="btn btn--butter" onClick={() => useRoom.getState().set({ discoverOpen: true })}>Pick what’s next</button>
        </div>
      )}

      <Countdown />
      <ReadyCard />

      {movie && !share && (
        <div className="stage__bar">
          <button className="ctl" onClick={togglePlay} aria-label={status === 'playing' ? 'Pause for everyone' : 'Play for everyone'} title={canControl ? 'Space' : 'Only the host can control playback'}>
            {status === 'playing' ? <PauseIcon /> : <PlayIcon />}
          </button>
          <span className="stage__time mono">{fmtTime(engine.pos)} <i>/</i> {engine.duration || movie.runtime ? fmtTime(engine.duration || movie.runtime) : '…'}</span>
          <span className="grow" />
          <button className="btn btn--glass btn--sm" onClick={startTogether} disabled={!canControl}>Start together</button>
          <CaptionsMenu />
          {movie.kind === 'youtube' && <QualityMenu />}
          <label className="vol">
            <button type="button" className="ctl" aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => setMuted((m) => !m)}>{muted || vol === 0 ? <MuteIcon /> : <VolIcon />}</button>
            <input type="range" min={0} max={1} step={0.02} value={muted ? 0 : vol} aria-label="Your volume (only affects you)" onChange={(e) => { setMuted(false); setVol(Number(e.target.value)); }} />
          </label>
          <button className="ctl" onClick={toggleFs} aria-label={fs ? 'Exit full screen' : 'Full screen'} title="F"><FsIcon /></button>
        </div>
      )}
    </div>
  );
}

/** YouTube's play-button shape in the room's own ink, not the brand red */
export const YouTubeMark = () => (
  <svg viewBox="0 0 28 20" width="22" height="16" aria-hidden><rect width="28" height="20" rx="6" fill="currentColor" /><path d="M11.5 5.5v9l7.5-4.5z" fill="var(--ink)" /></svg>
);

const I = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>{children}</svg>
);
const PlayIcon = () => <I><path d="M7 4.5v15l13-7.5z" /></I>;
const PauseIcon = () => <I><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></I>;
const VolIcon = () => <I><path d="M3 9v6h4l5 4V5L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z" /></I>;
const MuteIcon = () => <I><path d="M3 9v6h4l5 4V5L7 9H3zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z" /></I>;
const FsIcon = () => <I><path d="M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4z" /></I>;
