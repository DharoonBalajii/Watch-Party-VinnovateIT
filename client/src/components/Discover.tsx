import { useEffect, useMemo, useRef, useState } from 'react';
import Fuse from 'fuse.js';
import { CATALOG, CATALOG_BY_ID, GENRES, MOODS, type Movie } from '@shared/catalog';
import { loadMovie, queueMovie } from '../net/controls';
import { selectCanControl, useRoom, type DiscoverMode } from '../store';
import { LinkCard, looksLikeLink, UploadPanel, YouTubePanel } from './DiscoverPanels';
import { cx } from '../util';
import { PosterCard } from './PosterCard';



const fuse = new Fuse(CATALOG.map((m) => ({ ...m, yearStr: String(m.year) })), {
  keys: [
    { name: 'title', weight: 3 }, { name: 'genres', weight: 1.6 }, { name: 'moods', weight: 1.2 },
    { name: 'director', weight: 1 }, { name: 'blurb', weight: 0.5 }, { name: 'yearStr', weight: 0.8 },
  ],
  threshold: 0.38, ignoreLocation: true, minMatchCharLength: 2,
});

type Length = 'any' | 'short' | 'feature';
type Era = 'any' | 'pre30' | '30s-50s' | '60s-90s' | '2000s';
const ERAS: { id: Era; label: string; test: (y: number) => boolean }[] = [
  { id: 'any', label: 'Any era', test: () => true },
  { id: 'pre30', label: 'Before 1930', test: (y) => y < 1930 },
  { id: '30s-50s', label: '1930–59', test: (y) => y >= 1930 && y < 1960 },
  { id: '60s-90s', label: '1960–99', test: (y) => y >= 1960 && y < 2000 },
  { id: '2000s', label: '2000 on', test: (y) => y >= 2000 },
];

function similarity(a: Movie, b: Movie) {
  const g = a.genres.filter((x) => b.genres.includes(x));
  const m = a.moods.filter((x) => b.moods.includes(x));
  const score = g.length * 2 + m.length * 1.5 + (a.silent === b.silent ? 0.5 : 0) - Math.abs(a.year - b.year) / 120;
  return { score, why: [...g, ...m].slice(0, 3).join(' · ') };
}

export function Discover() {
  const open = useRoom((s) => s.discoverOpen);
  const mode = useRoom((s) => s.discoverMode);
  const videoId = useRoom((s) => s.state.videoId);
  const queue = useRoom((s) => s.queue);
  const canControl = useRoom(selectCanControl);
  const [q, setQ] = useState('');
  const [genres, setGenres] = useState<string[]>([]);
  const [moods, setMoods] = useState<string[]>([]);
  const [length, setLength] = useState<Length>('any');
  const [era, setEra] = useState<Era>('any');
  const inputRef = useRef<HTMLInputElement>(null);
  const close = () => useRoom.getState().set({ discoverOpen: false, discoverMode: 'browse' });

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open]);

  const queuedIds = useMemo(() => new Set(queue.map((x) => x.videoId)), [queue]);
  const now = videoId ? CATALOG_BY_ID[videoId] : null;
  const isLink = looksLikeLink(q);
  const filtering = !!q.trim() || genres.length > 0 || moods.length > 0 || length !== 'any' || era !== 'any';

  const results = useMemo(() => {
    const base = q.trim() ? fuse.search(q.trim()).map((r) => CATALOG_BY_ID[r.item.id]) : CATALOG;
    const eraTest = ERAS.find((e) => e.id === era)!.test;
    return base.filter((m) =>
      (!genres.length || genres.some((g) => m.genres.includes(g))) &&
      (!moods.length || moods.some((x) => m.moods.includes(x))) &&
      (length === 'any' || (length === 'short' ? m.runtime <= 1200 : m.runtime > 1200)) &&
      eraTest(m.year));
  }, [q, genres, moods, length, era]);

  const rails = useMemo(() => {
    const rest = CATALOG.filter((m) => m.id !== videoId);
    const out: { title: string; sub?: string; items: { m: Movie; reason?: string }[] }[] = [];
    if (now) {
      const sim = rest.map((m) => ({ m, ...similarity(now, m) })).filter((x) => x.score > 1).sort((a, b) => b.score - a.score).slice(0, 6);
      if (sim.length) out.push({ title: `More like ${now.title}`, sub: 'Shared genres and moods', items: sim.map((x) => ({ m: x.m, reason: x.why })) });
    }
    out.push({ title: 'Quick watches', sub: 'Done in under 20 minutes', items: rest.filter((m) => m.runtime <= 1200).sort((a, b) => a.runtime - b.runtime).map((m) => ({ m })) });
    out.push({ title: 'Laugh together', items: rest.filter((m) => m.moods.includes('Funny')).map((m) => ({ m })) });
    out.push({ title: 'Lights off', sub: 'Eerie and tense', items: rest.filter((m) => m.moods.includes('Eerie') || m.moods.includes('Tense')).map((m) => ({ m })) });
    out.push({ title: 'Silent-era classics', sub: 'No dialogue, all personality', items: rest.filter((m) => m.silent).map((m) => ({ m })) });
    out.push({ title: 'Big adventures', items: rest.filter((m) => m.moods.includes('Epic')).map((m) => ({ m })) });
    return out.filter((r) => r.items.length);
  }, [videoId, now]);

  const toggle = (arr: string[], set: (v: string[]) => void, v: string) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const clear = () => { setQ(''); setGenres([]); setMoods([]); setLength('any'); setEra('any'); };

  const card = (m: Movie, reason?: string) => (
    <PosterCard
      key={m.id}
      movie={m}
      reason={reason}
      playing={m.id === videoId}
      queued={queuedIds.has(m.id)}
      canControl={canControl}
      onPlay={() => { loadMovie(m.id); close(); }}
      onQueue={() => queueMovie(m.id)}
      onPoll={() => { const s = useRoom.getState(); s.set({ pollDraft: Array.from(new Set([...s.pollDraft, m.id])), tab: 'polls' }); close(); }}
    />
  );

  if (!open) return null;
  return (
    <div className="drawer" role="dialog" aria-modal="true" aria-label="Discover movies">
      <button className="drawer__scrim" aria-label="Close Discover" onClick={close} tabIndex={-1} />
      <div className="drawer__panel">
        <header className="drawer__head">
          <div>
            <p className="eyebrow">{TABS.find((t) => t.id === mode)!.eyebrow}</p>
            <h2>{TABS.find((t) => t.id === mode)!.title}</h2>
          </div>
          <button className="iconbtn iconbtn--lg" onClick={close} aria-label="Close">✕</button>
        </header>
        <div className="drawer__tabs" role="tablist" aria-label="What to put on">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={mode === t.id} className={cx('dtab', mode === t.id && 'is-on')} onClick={() => useRoom.getState().set({ discoverMode: t.id })}>{t.label}</button>
          ))}
        </div>

        {mode === 'upload' ? <UploadPanel canControl={canControl} onDone={close} /> : mode === 'link' ? <YouTubePanel canControl={canControl} onDone={close} /> : (<>
        <div className="drawer__search">
          <input
            ref={inputRef}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search the catalog, or paste a YouTube or video link"
            aria-label="Search movies or paste a link"
          />
        </div>

        {isLink ? (
          <div className="drawer__body"><LinkCard input={q} canControl={canControl} onDone={() => { setQ(''); close(); }} /></div>
        ) : (<>
        <div className="filters">
          <div className="chips" role="group" aria-label="Genre">
            {GENRES.map((g) => <button key={g} className={cx('chip', genres.includes(g) && 'is-on')} aria-pressed={genres.includes(g)} onClick={() => toggle(genres, setGenres, g)}>{g}</button>)}
          </div>
          <div className="chips" role="group" aria-label="Mood">
            {MOODS.map((g) => <button key={g} className={cx('chip chip--mood', moods.includes(g) && 'is-on')} aria-pressed={moods.includes(g)} onClick={() => toggle(moods, setMoods, g)}>{g}</button>)}
          </div>
          <div className="filters__row">
            <div className="seg" role="radiogroup" aria-label="Length">
              {([['any', 'Any length'], ['short', 'Under 20 min'], ['feature', 'Feature']] as [Length, string][]).map(([id, label]) => (
                <button key={id} role="radio" aria-checked={length === id} className={cx(length === id && 'is-on')} onClick={() => setLength(id)}>{label}</button>
              ))}
            </div>
            <div className="seg" role="radiogroup" aria-label="Era">
              {ERAS.map((e) => <button key={e.id} role="radio" aria-checked={era === e.id} className={cx(era === e.id && 'is-on')} onClick={() => setEra(e.id)}>{e.label}</button>)}
            </div>
            {filtering && <button className="btn btn--line btn--sm" onClick={clear}>Clear all</button>}
          </div>
        </div>

        <div className="drawer__body">
          {filtering ? (
            results.length ? (
              <>
                <p className="drawer__count mono">{results.length} {results.length === 1 ? 'title' : 'titles'}</p>
                <div className="pgrid">{results.map((m) => card(m))}</div>
              </>
            ) : (
              <div className="empty empty--big">
                <p>Nothing matches “{q}”{genres.length || moods.length ? ' with those filters' : ''}.</p>
                <button className="btn btn--butter" onClick={clear}>Clear search and filters</button>
              </div>
            )
          ) : (
            rails.map((r) => (
              <section key={r.title} className="rail-row">
                <div className="rail-row__head"><h3>{r.title}</h3>{r.sub && <span className="mono">{r.sub}</span>}</div>
                <div className="rail-row__scroll">{r.items.map((x) => card(x.m, x.reason))}</div>
              </section>
            ))
          )}
        </div>
        </>)}
        </>)}
      </div>
    </div>
  );
}

const TABS: { id: DiscoverMode; label: string; eyebrow: string; title: string }[] = [
  { id: 'browse', label: 'Films', eyebrow: 'Discover', title: 'What are we watching?' },
  { id: 'link', label: 'YouTube', eyebrow: 'YouTube', title: 'Watch YouTube together' },
  { id: 'upload', label: 'Upload a video', eyebrow: 'Your own video', title: 'Upload and watch' },
];

