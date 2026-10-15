import { useEffect, useMemo, useRef, useState } from 'react';
import { CATALOG_BY_ID } from '@shared/catalog';
import { formatRoomCode } from '@shared/protocol';
import { leaveRoom, loadProfile, openRoom, REMOTE_SERVER } from '../net/client';
import { WakeServer } from '../components/WakeServer';
import { seekBy, startTogether, togglePlay } from '../net/controls';
import { useRoom } from '../store';
import { cx } from '../util';
import { navigate } from '../App';
import { Header } from '../components/Header';
import { Player } from '../components/Player';
import { SyncStrip } from '../components/SyncStrip';
import { SeatRow } from '../components/SeatRow';
import { EmojiBar, FloatingReactions } from '../components/Reactions';
import { Rail } from '../components/Rail';
import { Discover } from '../components/Discover';
import { Toasts } from '../components/Toasts';
import { Lobby, LogoMark } from './Lobby';

export function Room({ code }: { code: string }) {
  const [profile, setProfile] = useState(loadProfile);
  if (!profile) return <Lobby invite={code} onJoined={() => setProfile(loadProfile())} />;
  return <LiveRoom code={code} profile={profile} />;
}

function LiveRoom({ code, profile }: { code: string; profile: NonNullable<ReturnType<typeof loadProfile>> }) {
  const status = useRoom((s) => s.status);
  const failMessage = useRoom((s) => s.failMessage);
  const videoId = useRoom((s) => s.state.videoId);
  const reconnects = useRoom((s) => s.reconnects);
  const stageRef = useRef<HTMLElement>(null);
  // still not connected after a few seconds on a separately hosted server → it is probably asleep
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!REMOTE_SERVER || status === 'live' || status === 'failed') { setSlow(false); return; }
    const t = window.setTimeout(() => setSlow(true), 5000);
    return () => window.clearTimeout(t);
  }, [status]);

  useEffect(() => {
    openRoom(code, profile);
    return () => leaveRoom();
  }, [code, profile]);

  useEffect(() => {
    const t = videoId ? CATALOG_BY_ID[videoId]?.title : null;
    document.title = `${t ? t + ' · ' : ''}Room ${formatRoomCode(code)} · Watch Party`;
    return () => { document.title = 'Watch Party — same movie, same second'; };
  }, [videoId, code]);

  // keyboard: space, ←/→, f, m, /
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable], [role="slider"], [role="dialog"] button')) {
        if (!(e.key === ' ' && t.closest('[role="slider"]'))) return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (useRoom.getState().discoverOpen) return;
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') seekBy(10);
      else if (e.key === 'ArrowLeft') seekBy(-10);
      else if (e.key.toLowerCase() === 'f') { if (document.fullscreenElement) void document.exitFullscreen(); else void stageRef.current?.requestFullscreen?.(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  if (status === 'failed') {
    return (
      <main className="gate">
        <LogoMark />
        <p className="eyebrow">Can’t take a seat</p>
        <h1>{failMessage || 'This room isn’t available.'}</h1>
        <div className="gate__actions">
          <button className="btn btn--butter btn--lg" onClick={() => navigate('/')}>Start a new room</button>
        </div>
      </main>
    );
  }

  return (
    <div className="room">
      <Header />
      {status === 'reconnecting' && (
        <div className="banner" role="status">
          <span className="spinner" /> Connection lost. Reconnecting — your seat is held for 30 seconds.{reconnects > 1 ? ` (attempt ${reconnects})` : ''}
        </div>
      )}
      {status === 'connecting' || (status === 'idle') ? (
        <div className="gate gate--inline">
          {slow ? (
            <div className="gate__wake"><WakeServer autoStart onAwake={() => setSlow(false)} /></div>
          ) : (
            <><span className="spinner spinner--lg" /><p className="mono">Taking your seat…</p></>
          )}
        </div>
      ) : (
        <div className="room__body">
          <section className="stage-col" ref={stageRef} aria-label="Screening" style={{ ['--glow' as string]: videoId ? CATALOG_BY_ID[videoId]?.accent[0] : undefined }}>
            <Player stageRef={stageRef} />
            <SyncStrip />
            <div className="reactrow">
              <EmojiBar />
              <div className="reactrow__right">
                <button className="btn btn--glass btn--sm" onClick={() => useRoom.getState().set({ discoverOpen: true })}>Find a movie</button>
                <button className="btn btn--butter btn--sm" onClick={startTogether} disabled={!videoId}>Start together</button>
              </div>
            </div>
            <SeatRow />
            <FloatingReactions containerRef={stageRef} />
          </section>
          <Rail />
        </div>
      )}
      <Discover />
      <Toasts />
    </div>
  );
}
