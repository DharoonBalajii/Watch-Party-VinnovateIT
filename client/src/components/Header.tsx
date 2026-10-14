import { useState } from 'react';
import { formatRoomCode } from '@shared/protocol';
import { getClient } from '../net/client';
import { propagationStats, selectCanControl, useRoom } from '../store';
import { cx, fmtMs, initials } from '../util';
import { LogoMark } from '../pages/Lobby';
import { Popover } from './Popover';
import { navigate } from '../App';

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const t = document.createElement('textarea');
    t.value = text; document.body.appendChild(t); t.select();
    const ok = document.execCommand('copy'); t.remove(); return ok;
  }
}

export function Header() {
  const code = useRoom((s) => s.code);
  const members = useRoom((s) => s.members);
  const status = useRoom((s) => s.status);
  const rtt = useRoom((s) => s.rtt);
  const engine = useRoom((s) => s.engine);
  const connected = members.filter((m) => m.connected);
  const tone = status !== 'live' ? 'bad' : engine.buffering || Math.abs(engine.drift) >= 0.4 ? 'bad' : Math.abs(engine.drift) >= 0.12 ? 'warn' : 'ok';

  return (
    <header className="rhead">
      <a className="wordmark" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }} aria-label="Watch Party home"><LogoMark /><span>Watch Party</span></a>

      <div className="rhead__room">
        <span className="mono rhead__label">Room</span>
        <b className="mono rhead__code">{formatRoomCode(code)}</b>
        <span className="rhead__count"><span className="dot dot--ok" /> {connected.length} watching</span>
      </div>

      <div className="rhead__right">
        <Popover label="Sync health" align="end" className="pop__panel--wide" triggerClassName={cx('chip-health', `chip-health--${tone}`)}
          trigger={() => (<><span className={cx('dot', `dot--${tone}`)} /> <span className="mono">{status === 'live' ? `${Math.round(rtt)} ms` : status === 'reconnecting' ? 'reconnecting' : '…'}</span></>)}>
          {() => <SyncHealth />}
        </Popover>
        <Popover label="Room settings" align="end" triggerClassName="iconbtn iconbtn--lg" trigger={() => <GearIcon />}>
          {() => <Settings />}
        </Popover>
        <Popover label="Invite friends" align="end" className="pop__panel--wide" triggerClassName="btn btn--butter" trigger={() => <>Invite</>}>
          {(close) => <Invite onDone={close} />}
        </Popover>
      </div>
    </header>
  );
}

function Invite({ onDone }: { onDone: () => void }) {
  const code = useRoom((s) => s.code);
  const link = `${location.origin}/r/${code}`;
  const [done, setDone] = useState<'link' | 'code' | null>(null);
  const flash = (k: 'link' | 'code') => { setDone(k); window.setTimeout(() => setDone(null), 1600); };
  const canShare = typeof navigator.share === 'function';
  return (
    <div className="invite">
      <p className="eyebrow">Invite</p>
      <h3>Send this to your friends</h3>
      <div className="invite__ticket">
        <span className="mono">Room code</span>
        <b>{formatRoomCode(code)}</b>
      </div>
      <input className="field__input mono" readOnly value={link} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
      <div className="invite__actions">
        <button className="btn btn--butter" onClick={async () => { await copy(link); flash('link'); }}>{done === 'link' ? 'Link copied' : 'Copy invite link'}</button>
        <button className="btn btn--line" onClick={async () => { await copy(formatRoomCode(code)); flash('code'); }}>{done === 'code' ? 'Code copied' : 'Copy code'}</button>
        {canShare && <button className="btn btn--line" onClick={() => navigator.share({ title: 'Watch Party', text: 'Join my watch party', url: link }).then(onDone).catch(() => {})}>Share…</button>}
      </div>
    </div>
  );
}

function Settings() {
  const settings = useRoom((s) => s.settings);
  const members = useRoom((s) => s.members);
  const youId = useRoom((s) => s.youId);
  const me = members.find((m) => m.id === youId);
  const isHost = !!me?.isHost;
  const send = (s: Partial<typeof settings>) => getClient()?.send({ t: 'settings', settings: s });
  return (
    <div className="settings">
      <h3 className="rail__h">Room settings</h3>
      <div className="setting">
        <div>
          <b>Who can control playback</b>
          <p>{isHost ? 'Play, pause, seek and change the movie.' : 'Only the host can change this.'}</p>
        </div>
        <div className="seg" role="radiogroup" aria-label="Who can control playback">
          {(['everyone', 'host'] as const).map((m) => (
            <button key={m} role="radio" aria-checked={settings.controlMode === m} disabled={!isHost} className={cx(settings.controlMode === m && 'is-on')} onClick={() => send({ controlMode: m })}>
              {m === 'everyone' ? 'Everyone' : 'Host only'}
            </button>
          ))}
        </div>
      </div>
      <div className="setting">
        <div>
          <b>Hold for stragglers</b>
          <p>Pause everyone while someone’s video is buffering, then resume together.</p>
        </div>
        <button role="switch" aria-checked={settings.holdForStragglers} disabled={!isHost} className={cx('switch', settings.holdForStragglers && 'is-on')} onClick={() => send({ holdForStragglers: !settings.holdForStragglers })}><i /></button>
      </div>
      <h3 className="rail__h">People</h3>
      <ul className="people">
        {members.map((m) => (
          <li key={m.id} style={{ ['--c' as string]: m.color }} className={cx(!m.connected && 'is-off')}>
            <span className="avatar avatar--sm">{initials(m.name)}</span>
            <span className="people__name">{m.name}{m.id === youId ? ' (you)' : ''}{m.isHost ? ' · host' : ''}{!m.connected ? ' · away' : ''}</span>
            {isHost && m.id !== youId && m.connected && <button className="btn btn--line btn--sm" onClick={() => getClient()?.send({ t: 'host_transfer', to: m.id })}>Make host</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SyncHealth() {
  const rtt = useRoom((s) => s.rtt);
  const offset = useRoom((s) => s.offset);
  const samples = useRoom((s) => s.clockSamples);
  const engine = useRoom((s) => s.engine);
  const prop = useRoom((s) => s.propagation);
  const status = useRoom((s) => s.status);
  const reconnects = useRoom((s) => s.reconnects);
  const health = useRoom((s) => s.health);
  const members = useRoom((s) => s.members);
  const youId = useRoom((s) => s.youId);
  const stats = propagationStats(prop);
  const others = members.filter((m) => m.connected);
  const inSync = others.filter((m) => Math.abs(m.id === youId ? engine.drift : health[m.id]?.drift ?? 0) < 0.12).length;
  const canControl = useRoom(selectCanControl);
  void canControl;

  const rows: [string, string, 'ok' | 'warn' | 'bad' | null][] = [
    ['Connection', status === 'live' ? 'Live' : status, status === 'live' ? 'ok' : 'bad'],
    ['Round trip to server', `${rtt.toFixed(1)} ms`, rtt < 100 ? 'ok' : 'warn'],
    ['Clock offset', `${fmtMs(offset / 1000)} · ${samples} samples`, null],
    ['Your drift', `${fmtMs(engine.drift)} · ${engine.mode}`, Math.abs(engine.drift) <= 0.5 ? 'ok' : 'bad'],
    ['Corrections', `${engine.corrections} total · ${engine.seeks} seeks`, null],
    ['Control latency here', stats ? `p50 ${stats.p50.toFixed(0)} · p95 ${stats.p95.toFixed(0)} ms · n=${stats.n}` : 'waiting for a play, pause or seek', stats ? (stats.p95 <= 250 ? 'ok' : 'bad') : null],
    ['Room in sync', `${inSync} of ${others.length} within 120 ms`, inSync === others.length ? 'ok' : 'warn'],
    ['Reconnects', String(reconnects), null],
  ];
  return (
    <div className="health">
      <h3 className="rail__h">Sync health</h3>
      <dl>
        {rows.map(([k, v, tone]) => (
          <div key={k}><dt>{k}</dt><dd className="mono">{tone && <span className={cx('dot', `dot--${tone}`)} />}{v}</dd></div>
        ))}
      </dl>
      <p className="hint">Targets: control changes reach everyone in ≤ 250 ms (p95) and playback stays within 500 ms of the room after correction.</p>
    </div>
  );
}

const GearIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <circle cx="12" cy="12" r="3.2" /><path d="M19.4 13.5a7.7 7.7 0 0 0 0-3l2-1.5-2-3.4-2.3.9a7.6 7.6 0 0 0-2.6-1.5L14.1 2h-4l-.4 2.5A7.6 7.6 0 0 0 7.1 6L4.8 5.1l-2 3.4 2 1.5a7.7 7.7 0 0 0 0 3l-2 1.5 2 3.4 2.3-.9a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.3.9 2-3.4-2-1.5z" />
  </svg>
);
