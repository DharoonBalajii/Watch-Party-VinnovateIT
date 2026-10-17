import { useEffect, useRef, useState } from 'react';
import { cuesAt, parseCues, type Cue } from '@shared/subtitles';
import { apiUrl, getClient } from '../net/client';
import { uploadSubtitles } from '../net/uploads';
import { useRoom, type YtQuality } from '../store';
import { cx, useFrame } from '../util';
import { getEngine } from './Player';
import { Popover } from './Popover';

const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

/** Captions drawn over the stage, timed off this viewer's own player. */
export function Captions() {
  const videoId = useRoom((s) => s.state.videoId);
  const subs = useRoom((s) => (s.state.videoId ? s.subs[s.state.videoId] : undefined));
  const on = useRoom((s) => s.ccOn);
  const [cues, setCues] = useState<Cue[]>([]);
  useEffect(() => {
    setCues([]);
    if (!subs) return;
    const ctl = new AbortController();
    fetch(apiUrl(`/api/subtitles/${subs.id}.vtt`), { signal: ctl.signal })
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => setCues(parseCues(t)))
      .catch(() => {});
    return () => ctl.abort();
  }, [subs, videoId]);
  useFrame(on && cues.length > 0);
  if (!on || !cues.length) return null;
  const t = getEngine()?.time();
  if (t == null) return null;
  const now = cuesAt(cues, t);
  if (!now.length) return null;
  return (
    <div className="captions" aria-live="off">
      {now.map((c, i) => <p key={i}>{c.text.split('\n').map((l, j) => <span key={j}>{l}</span>)}</p>)}
    </div>
  );
}

/** CC: turn captions on/off for yourself, add a .srt/.vtt for the room, or remove it. */
export function CaptionsMenu() {
  const videoId = useRoom((s) => s.state.videoId);
  const subs = useRoom((s) => (s.state.videoId ? s.subs[s.state.videoId] : undefined));
  const on = useRoom((s) => s.ccOn);
  const canRemove = useRoom((s) => {
    const sub = s.state.videoId ? s.subs[s.state.videoId] : undefined;
    return !!sub && (sub.by === s.youId || !!s.members.find((m) => m.id === s.youId)?.isHost);
  });
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!videoId) return null;

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setErr('');
    try {
      await uploadSubtitles(f, videoId);
      useRoom.getState().set({ ccOn: true });
      save('wp:cc', 'on');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const toggle = () => { const next = !on; useRoom.getState().set({ ccOn: next }); save('wp:cc', next ? 'on' : 'off'); };

  return (
    <Popover
      label="Subtitles"
      align="end"
      className="pop__panel--up pop__panel--menu"
      triggerClassName={cx('ctl ctl--text', subs && on && 'is-on')}
      trigger={() => <span className="mono">CC</span>}
    >
      {() => (
        <div className="menu">
          <p className="menu__title">Subtitles</p>
          {subs ? (
            <>
              <div className="menu__row">
                <span><b>{subs.label}</b><small className="mono">{subs.cues} lines</small></span>
                <button role="switch" aria-checked={on} aria-label="Show subtitles" className={cx('switch', on && 'is-on')} onClick={toggle}><i /></button>
              </div>
              <p className="hint">Turning them off only affects you.</p>
            </>
          ) : (
            <p className="hint">Add a .srt or .vtt file and everyone in the room gets the same subtitles, in sync.</p>
          )}
          <input ref={fileRef} type="file" accept=".srt,.vtt,text/vtt,application/x-subrip" hidden onChange={(e) => void pick(e.target.files?.[0])} />
          <div className="menu__actions">
            <button className="btn btn--butter btn--sm" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Adding…' : subs ? 'Replace file' : 'Add subtitles'}</button>
            {canRemove && <button className="btn btn--line btn--sm" onClick={() => getClient()?.send({ t: 'subs_clear', videoId })}>Remove</button>}
          </div>
          {err && <p className="menu__err" role="alert">{err}</p>}
        </div>
      )}
    </Popover>
  );
}

const QUALITIES: { id: YtQuality; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'hd1080', label: '1080p' },
  { id: 'hd720', label: '720p' },
  { id: 'large', label: '480p' },
];
const NAMES: Record<string, string> = { hd2160: '2160p', hd1440: '1440p', hd1080: '1080p', hd720: '720p', large: '480p', medium: '360p', small: '240p', tiny: '144p' };

/** YouTube quality for this viewer. */
export function QualityMenu() {
  const q = useRoom((s) => s.ytQuality);
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(() => {
    const t = window.setInterval(() => setPlaying(getEngine()?.ytQuality() ?? null), 1500);
    return () => window.clearInterval(t);
  }, []);
  const choose = (id: YtQuality) => { useRoom.getState().set({ ytQuality: id }); save('wp:ytq', id); };
  return (
    <Popover
      label="Video quality"
      align="end"
      className="pop__panel--up pop__panel--menu"
      triggerClassName="ctl ctl--text"
      trigger={() => <span className="mono">{q === 'auto' ? (playing && NAMES[playing] ? NAMES[playing] : 'HD') : QUALITIES.find((x) => x.id === q)!.label}</span>}
    >
      {(close) => (
        <div className="menu">
          <p className="menu__title">Quality</p>
          <div className="menu__list" role="radiogroup" aria-label="YouTube quality">
            {QUALITIES.map((x) => (
              <button key={x.id} role="radio" aria-checked={q === x.id} className={cx('menu__opt', q === x.id && 'is-on')} onClick={() => { choose(x.id); close(); }}>
                {x.label}
              </button>
            ))}
          </div>
          <p className="menu__now mono">Playing now: {playing && NAMES[playing] ? NAMES[playing] : '…'}</p>
          <p className="hint">Just for you. Reloads the video for a moment. YouTube won’t go below 480p.</p>
        </div>
      )}
    </Popover>
  );
}
