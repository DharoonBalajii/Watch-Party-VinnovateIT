import { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_CHAT_LEN } from '@shared/protocol';
import { getClient } from '../net/client';
import { useRoom } from '../store';
import { cx, initials } from '../util';

export function Chat() {
  const chat = useRoom((s) => s.chat);
  const members = useRoom((s) => s.members);
  const youId = useRoom((s) => s.youId);
  const typing = useRoom((s) => s.typing);
  const [text, setText] = useState('');
  const [stuck, setStuck] = useState(true);
  const [missed, setMissed] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const lastTyping = useRef(0);
  const [, tick] = useState(0);

  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 1000); return () => window.clearInterval(t); }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (stuck) { el.scrollTop = el.scrollHeight; setMissed(0); }
    else setMissed((m) => m + 1);
  }, [chat.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const typers = useMemo(
    () => members.filter((m) => m.id !== youId && (typing[m.id] ?? 0) > Date.now()).map((m) => m.name),
    [members, typing, youId, chat.length, tick], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    getClient()?.send({ t: 'chat', text: t });
    setText('');
    setStuck(true);
  };

  return (
    <div className="chat">
      <div
        className="chat__list"
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-label="Chat"
        onScroll={(e) => { const el = e.currentTarget; const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40; setStuck(near); if (near) setMissed(0); }}
      >
        {chat.length === 0 && <p className="empty">No messages yet. Say hi, or press 1–7 to react.</p>}
        {chat.map((m, i) => {
          if (m.from === null) return <p key={m.id} className="chat__sys mono">{m.text}</p>;
          const prev = chat[i - 1];
          const grouped = prev && prev.from === m.from && m.at - prev.at < 120000;
          const you = m.from === youId;
          return (
            <div key={m.id} className={cx('msg', you && 'is-you', grouped && 'is-grouped')} style={{ ['--c' as string]: m.color }}>
              {!grouped && <span className="avatar avatar--sm">{initials(m.name)}</span>}
              <div className="msg__body">
                {!grouped && (
                  <p className="msg__head">
                    <b>{you ? 'You' : m.name}</b>
                    <time className="mono" dateTime={new Date(m.at).toISOString()}>{new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                  </p>
                )}
                <p className="msg__text">{m.text}</p>
              </div>
            </div>
          );
        })}
      </div>
      {!stuck && missed > 0 && (
        <button className="chat__jump" onClick={() => { const el = listRef.current!; el.scrollTop = el.scrollHeight; }}>
          {missed} new {missed === 1 ? 'message' : 'messages'} ↓
        </button>
      )}
      <p className="chat__typing mono" aria-live="polite">
        {typers.length === 0 ? ' ' : typers.length === 1 ? `${typers[0]} is typing…` : `${typers.slice(0, 2).join(' and ')}${typers.length > 2 ? ' and others' : ''} are typing…`}
      </p>
      <form className="chat__form" onSubmit={send}>
        <input
          value={text}
          maxLength={MAX_CHAT_LEN}
          placeholder="Message the room"
          aria-label="Message the room"
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
            const now = Date.now();
            if (now - lastTyping.current > 1500) { lastTyping.current = now; getClient()?.send({ t: 'typing' }); }
          }}
        />
        <button className="btn btn--butter" type="submit" disabled={!text.trim()}>Send</button>
      </form>
    </div>
  );
}
