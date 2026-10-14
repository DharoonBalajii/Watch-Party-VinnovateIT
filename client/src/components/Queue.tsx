import { CATALOG_BY_ID } from '@shared/catalog';
import { getClient } from '../net/client';
import { selectCanControl, useRoom } from '../store';
import { cx, fmtRuntime } from '../util';
import { Poster } from './PosterCard';

export function Queue() {
  const queue = useRoom((s) => s.queue);
  const videoId = useRoom((s) => s.state.videoId);
  const members = useRoom((s) => s.members);
  const youId = useRoom((s) => s.youId);
  const canControl = useRoom(selectCanControl);
  const isHost = useRoom((s) => !!s.members.find((m) => m.id === s.youId)?.isHost);
  const now = videoId ? CATALOG_BY_ID[videoId] : null;
  const send = getClient()?.send.bind(getClient());

  return (
    <div className="queue">
      <section>
        <h3 className="rail__h">On screen</h3>
        {now ? (
          <div className="qnow">
            <Poster movie={now} size="mini" />
            <div>
              <b>{now.title}</b>
              <p className="mono">{now.year} · {fmtRuntime(now.runtime)}</p>
            </div>
          </div>
        ) : <p className="empty">Nothing yet. Pick a title from Discover.</p>}
      </section>

      <section>
        <div className="rail__hrow">
          <h3 className="rail__h">Up next <span className="mono">{queue.length}</span></h3>
          <button className="btn btn--glass btn--sm" onClick={() => useRoom.getState().set({ discoverOpen: true })}>Add from Discover</button>
        </div>
        {queue.length === 0 ? (
          <p className="empty">The queue is empty. Add a title, or start a poll and let the room pick.</p>
        ) : (
          <ol className="qlist">
            {queue.map((q, i) => {
              const m = CATALOG_BY_ID[q.videoId];
              if (!m) return null;
              const adder = members.find((x) => x.id === q.addedBy);
              const voted = q.votes.includes(youId);
              return (
                <li key={q.id} className="qitem">
                  <Poster movie={m} size="mini" />
                  <div className="qitem__body">
                    <b>{m.title}</b>
                    <p className="mono">{i === 0 ? 'Plays next · ' : ''}{adder ? `added by ${adder.id === youId ? 'you' : adder.name}` : 'from a poll'}</p>
                  </div>
                  <button className={cx('vote', voted && 'is-on')} aria-pressed={voted} aria-label={`${voted ? 'Remove your vote for' : 'Vote for'} ${m.title}`} onClick={() => send?.({ t: 'queue_vote', itemId: q.id })}>
                    <span aria-hidden>▲</span> {q.votes.length}
                  </button>
                  {canControl && <button className="iconbtn" aria-label={`Play ${m.title} now`} title="Play now" onClick={() => send?.({ t: 'queue_play', itemId: q.id })}>▶</button>}
                  {(isHost || q.addedBy === youId || canControl) && <button className="iconbtn" aria-label={`Remove ${m.title}`} title="Remove" onClick={() => send?.({ t: 'queue_remove', itemId: q.id })}>✕</button>}
                </li>
              );
            })}
          </ol>
        )}
        <p className="hint">Titles with the most votes play first. When a film ends, the next one starts with a shared countdown.</p>
      </section>
    </div>
  );
}
