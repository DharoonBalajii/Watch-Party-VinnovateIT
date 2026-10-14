import { useEffect, useRef, useState } from 'react';
import { CATALOG_BY_ID } from '@shared/catalog';
import { getClient } from '../net/client';
import { SyncEngine } from '../net/syncEngine';
import { togglePlay, startTogether } from '../net/controls';
import { selectCanControl, useRoom } from '../store';
import { cx, fmtTime } from '../util';
import { Countdown, ReadyCard } from './Countdown';
import { Poster } from './PosterCard';

let engineRef: SyncEngine | null = null;
export const getEngine = () => engineRef;

const loadVol = () => { try { return Number(localStorage.getItem('wp:vol') ?? '0.8'); } catch { return 0.8; } };

export function Player({ stageRef }: { stageRef: React.RefObject<HTMLElement | null> }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoId = useRoom((s) => s.state.videoId);
  const status = useRoom((s) => s.state.status);
  const engine = useRoom((s) => s.engine);
  const holding = useRoom((s) => s.holding);
  const members = useRoom((s) => s.members);
  const health = useRoom((s) => s.health);
  const youId = useRoom((s) => s.youId);
  const ready = useRoom((s) => s.ready);
  const canControl = useRoom(selectCanControl);
  const movie = videoId ? CATALOG_BY_ID[videoId] : null;
  const [vol, setVol] = useState(loadVol);
  const [muted, setMuted] = useState(false);
  const [fs, setFs] = useState(false);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number>(0);

  // engine lifecycle
  useEffect(() => {
    const v = videoRef.current!;
    const e = new SyncEngine(v);
    engineRef = e;
    const client = getClient();
    const onState = () => e.onState();
    client?.onState.push(onState);
    if (client) {
      client.getReport = () => {
        const s = useRoom.getState();
        return { pos: v.currentTime, drift: s.engine.drift, mode: s.engine.mode, buffering: s.engine.buffering };
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

  // load source when the room's video changes
  useEffect(() => {
    const v = videoRef.current!;
    if (!movie) { v.removeAttribute('src'); v.load(); return; }
    if (v.getAttribute('data-id') !== movie.id) {
      v.setAttribute('data-id', movie.id);
      v.src = movie.url;
      v.load();
      engineRef?.onState();
    }
  }, [movie]);

  useEffect(() => {
    const v = videoRef.current!;
    v.volume = vol;
    v.muted = muted;
    try { localStorage.setItem('wp:vol', String(vol)); } catch { /* ignore */ }
  }, [vol, muted]);

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
  const atEnd = !!movie && status === 'paused' && engine.duration > 0 && engine.pos >= engine.duration - 1.5;
  const controlsVisible = status === 'paused' || !idle || !movie;

  return (
    <div
      className={cx('stage', controlsVisible && 'is-ui', fs && 'is-fs')}
      onPointerMove={wake}
      onPointerLeave={() => setIdle(status === 'playing')}
    >
      <video ref={videoRef} className="stage__video" playsInline preload="auto" onClick={() => movie && canControl && togglePlay()} />

      {!movie && (
        <div className="stage__empty">
          <div className="stage__curtain" aria-hidden />
          <p className="eyebrow">The screen is dark</p>
          <h2>Nothing’s showing yet</h2>
          <p>Pick a title and it loads for everyone in the room at once.</p>
          <button className="btn btn--butter btn--lg" onClick={() => useRoom.getState().set({ discoverOpen: true })}>Find a movie</button>
        </div>
      )}

      {movie && (
        <div className="stage__title">
          <b>{movie.title}</b>
          <span className="mono">{movie.year}{movie.silent ? ' · silent' : ''}</span>
        </div>
      )}

      {engine.buffering && movie && !ready?.startAt && <div className="stage__spinner" role="status" aria-label="Buffering" />}

      {holding && (
        <div className="stage__banner" role="status">
          <span className="dot dot--amber" /> Holding for {stragglers.length ? stragglers.map((s) => s.name).join(', ') : 'someone'} to catch up
        </div>
      )}

      {engine.needsGesture && movie && (
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

      {movie && (
        <div className="stage__bar">
          <button className="ctl" onClick={togglePlay} aria-label={status === 'playing' ? 'Pause for everyone' : 'Play for everyone'} title={canControl ? 'Space' : 'Only the host can control playback'}>
            {status === 'playing' ? <PauseIcon /> : <PlayIcon />}
          </button>
          <span className="stage__time mono">{fmtTime(engine.pos)} <i>/</i> {fmtTime(engine.duration || movie.runtime)}</span>
          <span className="grow" />
          <button className="btn btn--glass btn--sm" onClick={startTogether} disabled={!canControl}>Start together</button>
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

export function MiniPoster({ id }: { id: string }) {
  const m = CATALOG_BY_ID[id];
  return m ? <Poster movie={m} size="mini" /> : null;
}

const I = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>{children}</svg>
);
const PlayIcon = () => <I><path d="M7 4.5v15l13-7.5z" /></I>;
const PauseIcon = () => <I><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></I>;
const VolIcon = () => <I><path d="M3 9v6h4l5 4V5L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z" /></I>;
const MuteIcon = () => <I><path d="M3 9v6h4l5 4V5L7 9H3zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z" /></I>;
const FsIcon = () => <I><path d="M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4z" /></I>;
