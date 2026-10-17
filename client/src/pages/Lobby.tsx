import { useEffect, useMemo, useRef, useState } from 'react';
import { AVATAR_COLORS, formatRoomCode, normalizeRoomCode } from '@shared/protocol';
import { navigate } from '../App';
import { apiUrl, loadProfile, pingServer, REMOTE_SERVER, saveProfile } from '../net/client';
import { WakeServer } from '../components/WakeServer';
import { cx } from '../util';

interface Props {
  /** set when arriving through an invite link */
  invite?: string;
  onJoined?: () => void;
}

export function Lobby({ invite, onJoined }: Props) {
  const saved = useMemo(loadProfile, []);
  const [name, setName] = useState('');
  const [color, setColor] = useState(saved?.color ?? AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tearing, setTearing] = useState(false);
  const [stubCode, setStubCode] = useState(invite ?? '');
  const [asleep, setAsleep] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const ticketRef = useRef<HTMLFormElement>(null);
  const toTicket = () => {
    ticketRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    window.setTimeout(() => nameRef.current?.focus({ preventScroll: true }), 350);
  };

  useEffect(() => { nameRef.current?.focus(); }, []);
  // a hosted server on a free tier may be asleep: check quietly so the visitor sees the wake-up panel straight away
  useEffect(() => {
    if (!REMOTE_SERVER) return;
    let live = true;
    pingServer(3500).then((ok) => { if (live && !ok) setAsleep(true); });
    return () => { live = false; };
  }, []);

  const requireName = () => {
    if (!name.trim()) {
      setError('Enter a name to take a seat.');
      nameRef.current?.focus();
      return false;
    }
    saveProfile({ name: name.trim().slice(0, 24), color });
    return true;
  };

  async function create() {
    if (!requireName()) return;
    setBusy(true); setError('');
    try {
      const res = await fetch(apiUrl('/api/rooms'), { method: 'POST' });
      if (!res.ok) throw new Error();
      const { code } = (await res.json()) as { code: string };
      setStubCode(code);
      setTearing(true);
      window.setTimeout(() => navigate(`/r/${code}`), window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 80 : 850);
    } catch {
      if (REMOTE_SERVER) setAsleep(true);
      else setError('Couldn’t reach the server. Check your connection and try again.');
      setBusy(false);
    }
  }

  async function join(e?: React.FormEvent) {
    e?.preventDefault();
    if (!requireName()) return;
    if (invite) { onJoined?.(); return; }
    const c = normalizeRoomCode(code);
    if (c.length !== 6) { setError('Room codes have 6 characters, like KQTM-72.'); return; }
    setBusy(true); setError('');
    try {
      const res = await fetch(apiUrl(`/api/rooms/${c}`));
      if (!res.ok) { setError(`Room ${formatRoomCode(c)} isn’t open. Check the code or start a new room.`); setBusy(false); return; }
      navigate(`/r/${c}`);
    } catch {
      if (REMOTE_SERVER) setAsleep(true);
      else setError('Couldn’t reach the server. Check your connection and try again.');
      setBusy(false);
    }
  }

  return (
    <div className="landing">
    <main className="lobby">
      <div className="lobby__beam" aria-hidden />
      <header className="lobby__top">
        <span className="wordmark"><LogoMark /> Watch Party</span>
        {!invite && (
          <nav className="lobby__nav" aria-label="On this page">
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
          </nav>
        )}
        <div className="credits">
          <div className="nametag" aria-label="Created by Dharoon Balajii">
            <span className="nametag__top mono">Created by</span>
            <b className="nametag__name">Dharoon Balajii</b>
          </div>
          <div className="nametag nametag--club" aria-label="VinnovateIT Recruitment'26">
            <span className="nametag__top mono">For</span>
            <b className="nametag__name">VinnovateIT</b>
            <span className="nametag__club mono">Recruitment’26</span>
          </div>
        </div>
      </header>

      <section className="lobby__hero">
        <p className="eyebrow">{invite ? 'You’re invited' : 'Screening room for friends'}</p>
        <h1 className="lobby__title">
          Same movie.<br /><span>Same second.</span>
        </h1>
        <p className="lobby__lede">
          {invite
            ? <>Room <b className="mono">{formatRoomCode(invite)}</b> is waiting. Pick a name and a seat color, then take your seat — the film is already in sync.</>
            : 'A private screening room for friends who are apart. Start a room, send the link, and play, pause and seek stay in lockstep for everyone, whether it’s a film from the catalog, a YouTube video or someone’s screen.'}
        </p>
        <p className="lobby__spec mono" aria-label="What’s included">
          Films <i /> YouTube <i /> Screen share <i /> Cameras <i /> No sign-up
        </p>
      </section>

      <form ref={ticketRef} className={cx('ticket', tearing && 'is-tearing')} onSubmit={join} aria-label={invite ? 'Join this room' : 'Start or join a room'}>
        <div className="ticket__main">
          <div className="ticket__kicker mono"><span>Admit one</span><span>Watch Party</span></div>

          <label className="field">
            <span className="field__label">Your name</span>
            <input
              ref={nameRef}
              className="field__input"
              value={name}
              maxLength={24}
              autoComplete="off"
              placeholder="Maya"
              onChange={(e) => { setName(e.target.value); setError(''); }}
            />
          </label>

          <fieldset className="swatches">
            <legend className="field__label">Seat color</legend>
            <div className="swatches__row" role="radiogroup" aria-label="Seat color">
              {AVATAR_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={c === color}
                  aria-label={`Seat color ${c}`}
                  className={cx('swatch', c === color && 'is-on')}
                  style={{ ['--c' as string]: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </fieldset>

          {asleep ? (
            <WakeServer onAwake={() => { setAsleep(false); setBusy(false); }} />
          ) : invite ? (
            <button className="btn btn--ink btn--xl" type="submit" disabled={busy}>Take your seat</button>
          ) : (
            <>
              <button className="btn btn--ink btn--xl" type="button" onClick={create} disabled={busy}>
                {busy && tearing ? 'Opening room…' : 'Start a room'}
              </button>
              <div className="ticket__or mono"><span>or join with a code</span></div>
              <div className="joinrow">
                <input
                  className="field__input mono joinrow__code"
                  value={code}
                  placeholder="KQTM-72"
                  aria-label="Room code"
                  autoCapitalize="characters"
                  spellCheck={false}
                  onChange={(e) => { setCode(e.target.value); setError(''); }}
                />
                <button className="btn btn--line" type="submit" disabled={busy}>Join</button>
              </div>
            </>
          )}
          <p className="ticket__error" role="alert" aria-live="polite">{error}</p>
        </div>

        <div className="ticket__stub" aria-hidden>
          <span className="mono stub__label">Room</span>
          <span className="stub__code">{stubCode ? formatRoomCode(stubCode) : 'XXXX-00'}</span>
          <span className="stub__bars" />
          <span className="mono stub__note">{invite ? 'Reserved for you' : 'Not valid after the credits'}</span>
        </div>
      </form>
      <div className="lobby__seats" aria-hidden />
    </main>
    {!invite && <Programme onStart={toTicket} />}
    </div>
  );
}

/** What the room can do, set like a film's end credits. */
const CREDITS: { role: string; title: string; text: string }[] = [
  { role: 'Synced playback', title: 'Same second, every screen', text: 'Play, pause and seek reach everyone together. Small slips are fixed by easing the speed, big ones by a quick seek, so nobody quietly falls behind.' },
  { role: 'Bring your own', title: 'YouTube and video links', text: 'Paste a YouTube link or a direct .mp4 or .webm file and it plays in the same lockstep as the catalog.' },
  { role: 'The catalog', title: '21 free films', text: 'Public-domain and Creative Commons films, from Blender shorts to silent classics, with search, filters and “more like this”.' },
  { role: 'Cameras & mics', title: 'Faces in the seats', text: 'Turn on your camera and your face appears on your seat in the row. Unmute to talk over the film.' },
  { role: 'Screen share', title: 'Put anything up', text: 'Share a tab, a window or your whole screen with the room. The film waits underneath until you’re done.' },
  { role: 'Together', title: 'Chat, reactions, queue, polls', text: 'Emoji that float up from your seat, a queue everyone can vote on, and polls whose winner plays next.' },
  { role: 'Start together', title: 'A 3-2-1 countdown', text: 'A ready check, then a film-leader countdown that starts on the same frame for everyone.' },
  { role: 'Hosting', title: 'You run the room', text: 'Make playback host-only, hand over hosting, remove someone, or lock the room so nobody new can join.' },
  { role: 'Slow connections', title: 'Hold for stragglers', text: 'If someone’s video is buffering, the room pauses and resumes together when they’ve caught up.' },
];

const STEPS = [
  { title: 'Start a room', text: 'Pick a name and a seat color. You get a room code and an invite link.' },
  { title: 'Send the link', text: 'Friends open it on a phone or a computer. No accounts, nothing to install.' },
  { title: 'Press play', text: 'Pick a film, paste a link or share your screen. Everyone watches the same second.' },
];

function Programme({ onStart }: { onStart(): void }) {
  return (
    <div className="programme">
      <section className="roll" id="features" aria-labelledby="roll-title">
        <p className="eyebrow">Features</p>
        <h2 id="roll-title" className="roll__title">Everything in the room</h2>
        <dl className="roll__list">
          {CREDITS.map((c) => (
            <div className="roll__row" key={c.role}>
              <dt className="mono">{c.role}</dt>
              <dd><b>{c.title}</b><p>{c.text}</p></dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="how" id="how" aria-labelledby="how-title">
        <p className="eyebrow">How it works</p>
        <h2 id="how-title" className="roll__title">Three steps to the opening credits</h2>
        <ol className="how__steps">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <span className="how__n" aria-hidden>{i + 1}</span>
              <b>{s.title}</b>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
        <button className="btn btn--butter btn--lg" onClick={onStart}>Start a room</button>
      </section>

      <footer className="foot">
        <span className="wordmark"><LogoMark /> Watch Party</span>
        <p>Built by <b>Dharoon Balajii</b> for VinnovateIT Recruitment’26.</p>
        <p className="foot__fine">Catalog films are public domain or Creative Commons. YouTube videos play through YouTube’s own player. Cameras and screens are encrypted between viewers and never recorded.</p>
      </footer>
    </div>
  );
}

export function LogoMark() {
  return (
    <svg className="logomark" viewBox="0 0 64 64" aria-hidden>
      <path d="M10 24h44v26a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V24z" fill="#FFD84A" />
      <path d="M10 24l6-12h9l-6 12M26 24l6-12h9l-6 12M42 24l6-12h8l-6 12" fill="#FF5C8A" />
      <path d="M28 33v14l12-7z" fill="#0F0E24" />
    </svg>
  );
}
