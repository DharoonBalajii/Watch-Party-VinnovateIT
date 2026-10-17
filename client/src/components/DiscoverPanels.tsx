import { useEffect, useRef, useState } from 'react';
import { parseSourceInput, UPLOAD_PREFIX } from '@shared/source';
import type { RoomUpload } from '@shared/protocol';
import { loadMovie, playLink, queueMovie } from '../net/controls';
import { fmtBytes, searchYouTube, uploadVideo, type YouTubeResult } from '../net/uploads';
import { useRoom, useSourceById } from '../store';
import { cx, fmtTime } from '../util';
import { Poster } from './PosterCard';

/** true once the search text is clearly a link rather than a title */
export const looksLikeLink = (q: string) => /^(https?:\/\/|www\.|youtu\.be\/|(m\.|music\.)?youtube\.com\/)/i.test(q.trim()) || /^[\w-]+(\.[\w-]+)+\/\S+/.test(q.trim());


/** Preview of a pasted link with the same actions a catalog card has. */
export function LinkCard({ input, canControl, onDone }: { input: string; canControl: boolean; onDone(): void }) {
  const parsed = parseSourceInput(input);
  const id = 'id' in parsed ? parsed.id : null;
  const src = useSourceById(id);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setErr(null), [input]);
  if (!src) return <div className="linkcard linkcard--bad" role="alert"><p className="eyebrow">Can’t play this</p><p>{'error' in parsed ? parsed.error : 'That link can’t play here.'}</p></div>;
  const act = (how: 'play' | 'queue') => { const e = playLink(input, how); if (e) setErr(e); else onDone(); };
  return (
    <div className="linkcard">
      <Poster source={src} />
      <div className="linkcard__body">
        <p className="eyebrow">{src.kind === 'youtube' ? 'YouTube video' : 'Video link'}</p>
        <h3>{src.title}</h3>
        <p className="mono linkcard__url">{src.kind === 'youtube' ? `youtu.be/${src.ytId}` : src.url}</p>
        {src.kind === 'url' && <p className="hint">Plays if the link points straight at a video file (.mp4 or .webm) that allows streaming. Page links like Vimeo or Google Drive won’t work.</p>}
        {src.kind === 'youtube' && <p className="hint">Everyone plays it in sync through YouTube’s player. Some videos have embedding turned off by their owner.</p>}
        <div className="pcard__actions">
          <button className="btn btn--butter" onClick={() => act('play')} disabled={!canControl} title={canControl ? undefined : 'Only the host can change what’s playing'}>Play now</button>
          <button className="btn btn--glass" onClick={() => act('queue')}>Queue</button>
          <button className="btn btn--glass" onClick={() => { const s = useRoom.getState(); s.set({ pollDraft: Array.from(new Set([...s.pollDraft, src.id])), tab: 'polls', discoverOpen: false }); }}>+ Poll</button>
        </div>
        {err && <p className="linkcard__err" role="alert">{err}</p>}
      </div>
    </div>
  );
}

export function LinkHelp({ searchable = false }: { searchable?: boolean }) {
  return (
    <div className="linkhelp">
      <p className="eyebrow">How to</p>
      <h3>{searchable ? 'Search, or paste a link' : 'Paste a YouTube link above'}</h3>
      <ul>
        {searchable && <li><b>Type what you want to watch</b><span>Results come straight from YouTube. Press Play now on one.</span></li>}
        <li><b>{searchable ? 'Or open the video on YouTube' : '1. Open the video on YouTube'}</b><span>On a phone, tap Share, then Copy link.</span></li>
        <li><b>{searchable ? 'Paste it in the box' : '2. Paste it in the box'}</b><span className="mono">youtube.com/watch?v=… · youtu.be/… · /shorts/…</span></li>
        {!searchable && <li><b>3. Press Play now</b><span>It starts for everyone in the room at the same second.</span></li>}
      </ul>
      <p className="hint">Direct video files (.mp4, .webm) work here too. To show anything else, like a tab or an app, close this and press Share screen.</p>
    </div>
  );
}

/** Search YouTube (through our server) or paste a YouTube link. */
export function YouTubePanel({ canControl, onDone }: { canControl: boolean; onDone(): void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<YouTubeResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const isLink = looksLikeLink(q) || /^[A-Za-z0-9_-]{11}$/.test(q.trim());
  const term = q.trim();

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    setErr('');
    if (isLink || term.length < 2 || unavailable) { setResults(null); setLoading(false); return; }
    const ctl = new AbortController();
    setLoading(true);
    const t = window.setTimeout(() => {
      searchYouTube(term, ctl.signal)
        .then((r) => { setResults(r); setLoading(false); })
        .catch((e: Error & { code?: string }) => {
          if (e.name === 'AbortError') return;
          if (e.code === 'not_configured') setUnavailable(true);
          setErr(e.message);
          setResults(null);
          setLoading(false);
        });
    }, 450);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [term, isLink, unavailable]);

  const play = (id: string) => {
    if (!canControl) return useRoom.getState().toast('Only the host can change what’s playing. Queue it instead.', 'error');
    loadMovie(`yt:${id}`);
    onDone();
  };

  return (
    <>
      <div className="drawer__search">
        <input
          ref={inputRef}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={unavailable ? 'Paste a YouTube link, like youtube.com/watch?v=…' : 'Search YouTube, or paste a link'}
          aria-label="Search YouTube or paste a YouTube link"
        />
      </div>
      <div className="drawer__body">
        {isLink ? (
          <LinkCard input={q} canControl={canControl} onDone={() => { setQ(''); onDone(); }} />
        ) : !term || unavailable ? (
          <>
            {unavailable && term && <p className="note" role="status">Searching isn’t set up on this server yet, so paste a YouTube link instead.</p>}
            <LinkHelp searchable={!unavailable} />
          </>
        ) : err ? (
          <div className="empty empty--big"><p>{err}</p></div>
        ) : loading && !results ? (
          <div className="ytgrid" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <div key={i} className="ytcard is-ghost" />)}</div>
        ) : results && !results.length ? (
          <div className="empty empty--big"><p>No YouTube videos found for “{term}”.</p></div>
        ) : (
          <div className={cx('ytgrid', loading && 'is-stale')}>
            {results?.map((r) => (
              <article key={r.id} className="ytcard">
                <div className="ytcard__thumb">
                  <img src={r.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  <span className="ytcard__dur mono">{r.live ? 'LIVE' : fmtTime(r.duration)}</span>
                </div>
                <b className="ytcard__title">{r.title}</b>
                <span className="ytcard__ch">{r.channel}</span>
                <div className="ytcard__actions">
                  <button className="btn btn--butter btn--sm" onClick={() => play(r.id)} disabled={!canControl}>Play now</button>
                  <button className="btn btn--glass btn--sm" onClick={() => queueMovie(`yt:${r.id}`)}>Queue</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

const STATUS: Record<RoomUpload['status'], string> = { uploading: 'Uploading', processing: 'Converting', ready: 'Ready', failed: 'Failed' };

/** Upload a video file to the server; everyone in the room can play it for 24 hours. */
export function UploadPanel({ canControl, onDone }: { canControl: boolean; onDone(): void }) {
  const uploads = useRoom((s) => s.uploads);
  const members = useRoom((s) => s.members);
  const youId = useRoom((s) => s.youId);
  const [active, setActive] = useState<{ name: string; size: number; sent: number; cancel(): void } | null>(null);
  const [err, setErr] = useState('');
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const start = (file: File | undefined) => {
    if (!file || active) return;
    setErr('');
    const job = uploadVideo(file, (sent) => setActive((a) => (a ? { ...a, sent } : a)));
    setActive({ name: file.name, size: file.size, sent: 0, cancel: job.cancel });
    job.done
      .then(() => setActive(null))
      .catch((e: Error) => { setActive(null); if (e.message !== 'Upload cancelled.') setErr(e.message); });
  };
  useEffect(() => () => active?.cancel(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="drawer__body">
      <label
        className={cx('drop', over && 'is-over', active && 'is-busy')}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); start(e.dataTransfer.files?.[0]); }}
      >
        <input ref={fileRef} type="file" accept="video/*,.mkv,.avi,.mov,.m4v,.webm,.mp4,.wmv,.flv,.ts" hidden disabled={!!active} onChange={(e) => { start(e.target.files?.[0]); e.target.value = ''; }} />
        {active ? (
          <>
            <p className="eyebrow">Uploading</p>
            <b className="drop__name">{active.name}</b>
            <span className="bar"><i style={{ width: `${Math.round(active.sent * 100)}%` }} /></span>
            <span className="mono drop__meta">{Math.round(active.sent * 100)}% of {fmtBytes(active.size)}</span>
            <button type="button" className="btn btn--line btn--sm" onClick={(e) => { e.preventDefault(); active.cancel(); }}>Cancel upload</button>
          </>
        ) : (
          <>
            <span className="drop__icon" aria-hidden>
              <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" /></svg>
            </span>
            <b className="drop__name">Drop a video here, or choose a file</b>
            <span className="drop__meta">MP4 and WebM play right away. MKV, MOV, AVI and others are converted first, which takes a while for a full film. Up to 4 GB.</span>
            <span className="btn btn--butter btn--sm">Choose a file</span>
          </>
        )}
      </label>
      {err && <p className="linkcard__err" role="alert">{err}</p>}

      <section>
        <div className="rail-row__head"><h3>In this room</h3><span className="mono">Kept for 24 hours</span></div>
        {uploads.length === 0 ? (
          <p className="empty">Nothing uploaded yet. Anyone in the room can upload, and everyone can play it.</p>
        ) : (
          <ul className="uplist">
            {uploads.map((u) => <UploadRow key={u.id} u={u} who={u.by === youId ? 'you' : members.find((m) => m.id === u.by)?.name ?? 'someone'} canControl={canControl} onDone={onDone} />)}
          </ul>
        )}
      </section>
    </div>
  );
}

function UploadRow({ u, who, canControl, onDone }: { u: RoomUpload; who: string; canControl: boolean; onDone(): void }) {
  const src = useSourceById(UPLOAD_PREFIX + u.id);
  const pct = Math.round(u.progress * 100);
  return (
    <li className={cx('uprow', `uprow--${u.status}`)}>
      {src && <Poster source={src} size="mini" />}
      <div className="uprow__body">
        <b>{u.name}</b>
        <p className="mono">
          {fmtBytes(u.size)}{u.duration ? ` · ${fmtTime(u.duration)}` : ''} · by {who} · {STATUS[u.status]}{u.status === 'uploading' || u.status === 'processing' ? ` ${pct}%` : ''}
        </p>
        {(u.status === 'uploading' || u.status === 'processing') && <span className="bar bar--thin"><i style={{ width: `${pct}%` }} /></span>}
        {u.status === 'failed' && <p className="uprow__err">{u.error}</p>}
      </div>
      {u.status === 'ready' && (
        <div className="uprow__actions">
          <button className="btn btn--butter btn--sm" disabled={!canControl} onClick={() => { loadMovie(UPLOAD_PREFIX + u.id); onDone(); }}>Play now</button>
          <button className="btn btn--glass btn--sm" onClick={() => queueMovie(UPLOAD_PREFIX + u.id)}>Queue</button>
        </div>
      )}
    </li>
  );
}
