import { useState } from 'react';
import { getClient } from '../net/client';
import { useRoom } from '../store';
import { cx, fmtMs, initials } from '../util';

export function SeatRow() {
  const members = useRoom((s) => s.members);
  const health = useRoom((s) => s.health);
  const youId = useRoom((s) => s.youId);
  const engine = useRoom((s) => s.engine);
  const ready = useRoom((s) => s.ready);
  const typing = useRoom((s) => s.typing);
  const [menu, setMenu] = useState<string | null>(null);
  const me = members.find((m) => m.id === youId);

  return (
    <div className="seats" role="list" aria-label="Viewers">
      {members.map((m) => {
        const h = health[m.id];
        const you = m.id === youId;
        const drift = you ? engine.drift : h?.drift ?? 0;
        const buffering = you ? engine.buffering : !!h?.buffering;
        const mode = you ? engine.mode : h?.mode ?? 'idle';
        const tone = !m.connected ? 'off' : buffering || Math.abs(drift) >= 0.4 ? 'bad' : Math.abs(drift) >= 0.12 || mode === 'nudge' ? 'warn' : 'ok';
        const isReady = ready?.active && ready.ready.includes(m.id);
        const clamp = Math.max(-0.5, Math.min(0.5, drift));
        const isTyping = (typing[m.id] ?? 0) > Date.now();
        return (
          <div role="listitem" key={m.id} className={cx('seat', `seat--${tone}`, you && 'is-you', !m.connected && 'is-off')} style={{ ['--c' as string]: m.color }} data-seat={m.id}>
            <button
              className="seat__btn"
              onClick={() => setMenu(menu === m.id ? null : m.id)}
              aria-label={`${m.name}${you ? ' (you)' : ''}${m.isHost ? ', host' : ''}${m.connected ? '' : ', reconnecting'}`}
              aria-expanded={menu === m.id}
            >
              <svg className="seat__chair" viewBox="0 0 64 60" aria-hidden>
                <path d="M10 8a8 8 0 0 1 8-8h28a8 8 0 0 1 8 8v26H10V8z" className="seat__back" />
                <path d="M4 26a6 6 0 0 1 6-6h2v30H8a4 4 0 0 1-4-4V26zM60 26a6 6 0 0 0-6-6h-2v30h4a4 4 0 0 0 4-4V26z" className="seat__arm" />
                <path d="M10 34h44a4 4 0 0 1 4 4v8a6 6 0 0 1-6 6H12a6 6 0 0 1-6-6v-8a4 4 0 0 1 4-4z" className="seat__cushion" />
              </svg>
              <span className="avatar">{initials(m.name)}</span>
              {m.isHost && <span className="seat__crown" title="Host" aria-hidden>♛</span>}
              {isReady && <span className="seat__ready" aria-hidden>✓</span>}
              {buffering && m.connected && <span className="seat__buf" aria-hidden />}
              {isTyping && <span className="seat__typing" aria-hidden><i /><i /><i /></span>}
            </button>
            <span className="seat__name">{you ? 'You' : m.name}</span>
            <span className="seat__gauge" aria-hidden>
              <i className="seat__gauge-mid" />
              <i className="seat__gauge-dot" style={{ left: `${50 + (clamp / 0.5) * 50}%` }} />
            </span>
            <span className="seat__ms mono">{!m.connected ? 'away' : buffering ? 'buffering' : Math.abs(drift) < 0.01 ? 'in sync' : fmtMs(drift)}</span>

            {menu === m.id && (
              <div className="seat__menu" role="menu" onMouseLeave={() => setMenu(null)}>
                <p className="seat__menu-title">{m.name}{m.isHost ? ' · host' : ''}</p>
                {me?.isHost && !you && m.connected && (
                  <button role="menuitem" onClick={() => { getClient()?.send({ t: 'host_transfer', to: m.id }); setMenu(null); }}>Make host</button>
                )}
                <p className="mono seat__menu-meta">
                  {m.connected ? `${fmtMs(drift)} · ${mode} · ${h?.rtt ? Math.round(h.rtt) : you ? Math.round(useRoom.getState().rtt) : 0} ms rtt` : 'Reconnecting — seat held'}
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
