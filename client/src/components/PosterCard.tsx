import type { Movie } from '@shared/catalog';
import { resolveSource, type Source } from '@shared/source';
import { cx, fmtRuntime } from '../util';

/** Generated typographic poster — no third-party artwork. YouTube sources show their thumbnail. */
export function Poster({ movie, source, size = 'md' }: { movie?: Movie; source?: Source | null; size?: 'mini' | 'md' | 'lg' }) {
  const src = source ?? (movie ? resolveSource(movie.id) : null);
  if (!src) return null;
  // size the title so the longest word always fits on one line (no mid-word breaks)
  const longest = Math.max(...src.title.split(/\s+/).map((w) => w.length));
  const fit = Math.max(22, Math.min(34, Math.floor(150 / (longest * 0.5))));
  return (
    <div className={cx('poster', `poster--${size}`, src.thumb && 'poster--thumb', src.kind !== 'catalog' && `poster--${src.kind}`)} style={{ ['--a' as string]: src.accent[0], ['--b' as string]: src.accent[1] }} aria-hidden>
      {src.thumb && <img className="poster__img" src={src.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" />}
      <span className="poster__year mono">{src.kind === 'catalog' ? src.label : src.kind === 'youtube' ? 'YouTube' : src.kind === 'upload' ? 'Upload' : 'Link'}</span>
      <span className="poster__title" style={size === 'mini' ? undefined : { fontSize: fit }}>{src.title}</span>
      {size !== 'mini' && src.runtime > 0 && <span className="poster__rt mono">{fmtRuntime(src.runtime)}</span>}
    </div>
  );
}

interface CardProps {
  movie: Movie;
  playing?: boolean;
  queued?: boolean;
  canControl: boolean;
  onPlay(): void;
  onQueue(): void;
  onPoll(): void;
  reason?: string;
}

export function PosterCard({ movie, playing, queued, canControl, onPlay, onQueue, onPoll, reason }: CardProps) {
  return (
    <article className={cx('pcard', playing && 'is-playing')}>
      <Poster movie={movie} />
      {playing && <span className="pcard__badge mono">On screen</span>}
      {!playing && queued && <span className="pcard__badge pcard__badge--q mono">Queued</span>}
      <div className="pcard__meta">
        <p className="pcard__genres">{movie.genres.slice(0, 3).join(' · ')}</p>
        {reason && <p className="pcard__reason mono">{reason}</p>}
      </div>
      <div className="pcard__actions">
        <button className="btn btn--butter btn--sm" onClick={onPlay} disabled={!canControl || playing} title={canControl ? undefined : 'Only the host can change the movie'}>Play now</button>
        <button className="btn btn--glass btn--sm" onClick={onQueue} disabled={playing || queued}>{queued ? 'Queued' : 'Queue'}</button>
        <button className="btn btn--glass btn--sm" onClick={onPoll} aria-label={`Add ${movie.title} to a poll`}>+ Poll</button>
      </div>
    </article>
  );
}
