import { useEffect, useState } from 'react';
import { getClient } from '../net/client';
import { useRoom } from '../store';
import { cx, initials, useFrame } from '../util';

/** Film-leader countdown: lands on frame 0 at the same server instant for everyone. */
export function Countdown() {
  const startAt = useRoom((s) => s.ready?.startAt);
  const [, force] = useState(0);
  const now = getClient()?.serverNow() ?? 0;
  const active = !!startAt && now < startAt + 450;
  useFrame(active);
  useEffect(() => { if (startAt) force((n) => n + 1); }, [startAt]);
  if (!startAt || !active) return null;

  const left = startAt - now;
  const done = left <= 0;
  const n = Math.min(3, Math.max(1, Math.ceil(left / 1000)));
  const frac = done ? 1 : 1 - (left % 1000 || 1000) / 1000; // sweep 0→1 each second
  return (
    <div className={cx('leader', done && 'is-go')} role="timer" aria-live="assertive" aria-label={done ? 'Playing' : `Starting in ${n}`}>
      <div className="leader__grain" aria-hidden />
      <div className="leader__sweep" style={{ ['--a' as string]: `${frac * 360}deg` }} aria-hidden />
      <div className="leader__ring" aria-hidden />
      <div className="leader__ring leader__ring--in" aria-hidden />
      <div className="leader__cross" aria-hidden />
      <div className="leader__num" key={done ? 'go' : n}>{done ? '▶' : n}</div>
      <p className="leader__cap mono">{done ? 'Roll film' : 'Starting together'}</p>
    </div>
  );
}

/** Ready check — also the tap that unlocks audio autoplay on this device. */
export function ReadyCard() {
  const ready = useRoom((s) => s.ready);
  const members = useRoom((s) => s.members);
  const youId = useRoom((s) => s.youId);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    if (!ready?.active) return;
    const t = window.setInterval(() => setLeft(Math.max(0, Math.ceil((ready.deadline - (getClient()?.serverNow() ?? 0)) / 1000))), 250);
    return () => window.clearInterval(t);
  }, [ready?.active, ready?.deadline]);

  if (!ready?.active) return null;
  const connected = members.filter((m) => m.connected);
  const mine = ready.ready.includes(youId);
  const starter = members.find((m) => m.id === ready.startedBy);
  const send = (r: boolean) => getClient()?.send({ t: 'ready', ready: r });

  return (
    <div className="readycard" role="dialog" aria-label="Ready check">
      <p className="eyebrow">{starter ? `${starter.name} wants to start` : 'Ready check'}</p>
      <h2>Ready when you are</h2>
      <ul className="readycard__seats">
        {connected.map((m) => (
          <li key={m.id} className={cx(ready.ready.includes(m.id) && 'is-ready')} style={{ ['--c' as string]: m.color }}>
            <span className="avatar avatar--sm">{initials(m.name)}</span>
            <span>{m.name}</span>
            <b aria-label={ready.ready.includes(m.id) ? 'ready' : 'not ready yet'}>{ready.ready.includes(m.id) ? '✓' : '…'}</b>
          </li>
        ))}
      </ul>
      <div className="readycard__actions">
        <button className={cx('btn btn--lg', mine ? 'btn--line' : 'btn--butter')} onClick={() => send(!mine)} autoFocus>
          {mine ? 'Not ready' : 'I’m ready'}
        </button>
        <span className="mono readycard__count">{ready.ready.length} of {connected.length} · starts in {left}s at most</span>
      </div>
    </div>
  );
}
