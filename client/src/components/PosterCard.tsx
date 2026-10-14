import type { Movie } from '@shared/catalog';
import { cx, fmtRuntime } from '../util';

/** Generated typographic poster — no third-party artwork. */
export function Poster({ movie, size = 'md' }: { movie: Movie; size?: 'mini' | 'md' | 'lg' }) {
  // size the title so the longest word always fits on one line (no mid-word breaks)
  const longest = Math.max(...movie.title.split(/\s+/).map((w) => w.length));
  const fit = Math.max(22, Math.min(34, Math.floor(150 / (longest * 0.5))));
  return (
    <div className={cx('poster', `poster--${size}`)} style={{ ['--a' as string]: movie.accent[0], ['--b' as string]: movie.accent[1] }} aria-hidden>
      <span className="poster__year mono">{movie.year}</span>
      <span className="poster__title" style={size === 'mini' ? undefined : { fontSize: fit }}>{movie.title}</span>
      {size !== 'mini' && <span className="poster__rt mono">{fmtRuntime(movie.runtime)}</span>}
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
