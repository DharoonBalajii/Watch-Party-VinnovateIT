import { useMemo, useRef, useState } from 'react';
import { CATALOG_BY_ID } from '@shared/catalog';
import { HEAT_BUCKET_S } from '@shared/protocol';
import { seekTo } from '../net/controls';
import { selectCanControl, useRoom } from '../store';
import { cx, fmtMs, fmtTime, roomPosition, useFrame } from '../util';

function status(drift: number, buffering: boolean) {
  if (buffering || Math.abs(drift) >= 0.4) return 'bad';
  if (Math.abs(drift) >= 0.12) return 'warn';
  return 'ok';
}

/** Film-strip timeline: reaction heat + every viewer's playhead. Doubles as the seek bar. */
export function SyncStrip() {
  const videoId = useRoom((s) => s.state.videoId);
  const status0 = useRoom((s) => s.state.status);
  const engine = useRoom((s) => s.engine);
  const heat = useRoom((s) => s.heat);
  const members = useRoom((s) => s.members);
  const health = useRoom((s) => s.health);
  const youId = useRoom((s) => s.youId);
  const canControl = useRoom(selectCanControl);
  const movie = videoId ? CATALOG_BY_ID[videoId] : null;
  const dur = engine.duration || movie?.runtime || 1;
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  useFrame(!!movie);

  const peak = useMemo(() => Math.max(1, ...heat.map((h) => h.count)), [heat]);
  if (!movie) {
    return <div className="strip strip--empty" aria-hidden><div className="strip__track" /></div>;
  }

  const pos = roomPosition(dur);
  const pct = (p: number) => `${Math.min(100, Math.max(0, (p / dur) * 100))}%`;
  const at = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return Math.min(dur, Math.max(0, ((clientX - r.left) / r.width) * dur));
  };
  const heatAt = (p: number) => heat.find((h) => h.bucket === Math.floor(p / HEAT_BUCKET_S))?.count ?? 0;

  const pins = members.filter((m) => m.connected).map((m, i) => {
    const d = m.id === youId ? engine.drift : health[m.id]?.drift ?? 0;
    const buf = m.id === youId ? engine.buffering : !!health[m.id]?.buffering;
    return { m, p: pos + d, st: status(d, buf), d, i };
  });
  const shown = scrub ?? hover;

  return (
    <div className={cx('strip', !canControl && 'is-locked')}>
      <span className="strip__t mono">{fmtTime(pos)}</span>
      <div
        className="strip__track"
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Timeline — seeks for everyone"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(pos)}
        aria-valuetext={fmtTime(pos)}
        onPointerMove={(e) => { const p = at(e.clientX); setHover(p); if (scrub !== null) setScrub(p); }}
        onPointerLeave={() => setHover(null)}
        onPointerDown={(e) => {
          if (!canControl) { useRoom.getState().toast('Only the host can seek right now.', 'error'); return; }
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setScrub(at(e.clientX));
        }}
        onPointerUp={(e) => { if (scrub === null) return; seekTo(at(e.clientX)); setScrub(null); }}
        onPointerCancel={() => setScrub(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(pos + 10); }
          if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(pos - 10); }
        }}
      >
        <div className="strip__film" aria-hidden>
          {heat.map((h) => (
            <i
              key={h.bucket}
              className="strip__heat"
              style={{ left: pct(h.bucket * HEAT_BUCKET_S), width: `max(3px, ${(HEAT_BUCKET_S / dur) * 100}%)`, height: `${6 + (h.count / peak) * 15}px`, opacity: 0.35 + (h.count / peak) * 0.65 }}
            />
          ))}
          <i className="strip__done" style={{ width: pct(pos) }} />
          {shown !== null && <i className="strip__ghost" style={{ left: pct(shown) }} />}
          <i className="strip__head" style={{ left: pct(scrub ?? pos) }} />
        </div>

        <div className="strip__pins" aria-hidden>
          {pins.map(({ m, p, st, i }) => (
            <i key={m.id} className={cx('pin', `pin--${st}`, m.id === youId && 'is-you')} style={{ left: pct(p), ['--c' as string]: m.color, ['--y' as string]: `${(i % 3) * -2}px` }} />
          ))}
        </div>

        {shown !== null && (
          <div className="strip__tip mono" style={{ left: `clamp(28px, ${(shown / dur) * 100}%, calc(100% - 28px))` }}>
            {fmtTime(shown)}
            {heatAt(shown) > 0 && <span> · {heatAt(shown)} 🔥</span>}
          </div>
        )}
      </div>
      <span className="strip__t mono">{fmtTime(dur)}</span>
      <span className="strip__legend mono" aria-hidden>
        {status0 === 'playing' ? 'Live' : 'Paused'} · {pins.filter((p) => p.st === 'ok').length}/{pins.length} in sync
        {Math.abs(engine.drift) >= 0.08 && <> · you {fmtMs(engine.drift)}</>}
      </span>
    </div>
  );
}
