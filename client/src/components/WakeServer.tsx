import { useEffect, useRef, useState } from 'react';
import { pingServer } from '../net/client';
import { cx } from '../util';

/** Render's free tier sleeps when idle and needs ~30 s to wake. 40 s leaves 10 s of slack. */
const WAKE_SECONDS = 40;

type Phase = 'asleep' | 'waking' | 'awake' | 'failed';

interface Props {
  onAwake(): void;
  /** start the countdown immediately instead of waiting for a click */
  autoStart?: boolean;
}

export function WakeServer({ onAwake, autoStart }: Props) {
  const [phase, setPhase] = useState<Phase>('asleep');
  const [left, setLeft] = useState(WAKE_SECONDS);
  const run = useRef(0); // each wake attempt gets an id; stale loops (unmount, StrictMode, retry) stop themselves

  useEffect(() => {
    if (autoStart) void wake();
    return () => { run.current++; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function wake() {
    const id = ++run.current;
    setPhase('waking');
    setLeft(WAKE_SECONDS);
    const t0 = Date.now();
    const tick = window.setInterval(() => setLeft(Math.max(0, WAKE_SECONDS - (Date.now() - t0) / 1000)), 100);
    let ok = false;
    while (run.current === id && Date.now() - t0 < WAKE_SECONDS * 1000) {
      // each attempt is both a wake-up call and a health check
      if (await pingServer(4000)) { ok = true; break; }
      await new Promise((r) => setTimeout(r, 1200));
    }
    window.clearInterval(tick);
    if (run.current !== id) return;
    if (ok) {
      setPhase('awake');
      window.setTimeout(() => { if (run.current === id) onAwake(); }, 1100);
    } else {
      setPhase('failed');
    }
  }

  const secs = Math.ceil(left);
  const frac = 1 - left / WAKE_SECONDS; // 0 → 1
  const stage = left > 20 ? 'Warming up the projector…' : left > 8 ? 'Threading the film…' : 'Almost ready…';

  return (
    <div className={cx('wake', `wake--${phase}`)} role="status" aria-live="polite">
      {phase === 'asleep' && (
        <>
          <p className="wake__title">The server is asleep</p>
          <p className="wake__text">It naps when nobody's around. Waking it takes about 30 seconds.</p>
          <button className="btn btn--ink btn--xl" type="button" onClick={wake}>Start the server</button>
        </>
      )}

      {phase === 'waking' && (
        <>
          <div className="wake__dial" style={{ ['--p' as string]: `${frac * 360}deg` }} aria-label={`${secs} seconds left`}>
            <div className="wake__ring" aria-hidden />
            <div className="wake__ticks" aria-hidden />
            <span className="wake__num" key={secs}>{secs}</span>
          </div>
          <p className="wake__stage mono">{stage}</p>
          <div className="wake__bar" aria-hidden><i style={{ width: `${frac * 100}%` }} /></div>
        </>
      )}

      {phase === 'awake' && (
        <>
          <div className="wake__dial wake__dial--done" aria-hidden><span className="wake__num">▶</span></div>
          <p className="wake__title">Roll film!</p>
          <p className="wake__text">The server is awake.</p>
        </>
      )}

      {phase === 'failed' && (
        <>
          <p className="wake__title">Still waking up</p>
          <p className="wake__text">It's taking longer than usual. Give it another go, or check that the server is running on Render.</p>
          <button className="btn btn--ink btn--xl" type="button" onClick={wake}>Try again</button>
        </>
      )}
    </div>
  );
}
