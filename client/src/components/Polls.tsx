import { useEffect, useState } from 'react';
import { CATALOG, CATALOG_BY_ID } from '@shared/catalog';
import { getClient } from '../net/client';
import { useRoom } from '../store';
import { cx, initials } from '../util';

export function Polls() {
  const polls = useRoom((s) => s.polls);
  const members = useRoom((s) => s.members);
  const youId = useRoom((s) => s.youId);
  const draft = useRoom((s) => s.pollDraft);
  const isHost = useRoom((s) => !!s.members.find((m) => m.id === s.youId)?.isHost);
  const [composing, setComposing] = useState(false);

  useEffect(() => { if (draft.length) setComposing(true); }, [draft]);

  return (
    <div className="polls">
      <div className="rail__hrow">
        <h3 className="rail__h">Group polls</h3>
        {!composing && <button className="btn btn--butter btn--sm" onClick={() => setComposing(true)}>New poll</button>}
      </div>
      {composing && <Composer onDone={() => { setComposing(false); useRoom.getState().set({ pollDraft: [] }); }} />}
      {polls.length === 0 && !composing && <p className="empty">No polls yet. Ask the room what to watch next — the winner joins the queue automatically.</p>}
      {polls.map((p) => {
        const total = p.options.reduce((n, o) => n + o.votes.length, 0);
        const mine = p.options.find((o) => o.votes.includes(youId))?.id;
        const creator = members.find((m) => m.id === p.createdBy);
        return (
          <section key={p.id} className={cx('poll', !p.open && 'is-closed')}>
            <header>
              <h4>{p.question}</h4>
              <p className="mono">{p.open ? 'Open' : 'Closed'} · by {creator?.id === youId ? 'you' : creator?.name ?? 'someone who left'} · {total} vote{total === 1 ? '' : 's'}</p>
            </header>
            <ul>
              {p.options.map((o) => {
                const pct = total ? Math.round((o.votes.length / total) * 100) : 0;
                const win = p.winnerOptionId === o.id;
                return (
                  <li key={o.id}>
                    <button
                      className={cx('opt', mine === o.id && 'is-mine', win && 'is-win')}
                      disabled={!p.open}
                      aria-pressed={mine === o.id}
                      onClick={() => getClient()?.send({ t: 'poll_vote', pollId: p.id, optionId: o.id })}
                    >
                      <span className="opt__bar" style={{ width: `${pct}%` }} aria-hidden />
                      <span className="opt__label">{win && <b className="opt__win">Winner</b>}{o.label}</span>
                      <span className="opt__dots" aria-hidden>
                        {o.votes.slice(0, 6).map((v) => { const m = members.find((x) => x.id === v); return <i key={v} style={{ background: m?.color ?? '#888' }} title={m?.name} />; })}
                      </span>
                      <span className="opt__n mono">{o.votes.length}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {p.open && (isHost || p.createdBy === youId) && (
              <button className="btn btn--line btn--sm" onClick={() => getClient()?.send({ t: 'poll_close', pollId: p.id })}>Close poll and queue the winner</button>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Composer({ onDone }: { onDone: () => void }) {
  const draft = useRoom((s) => s.pollDraft);
  const [q, setQ] = useState('What should we watch next?');
  const [opts, setOpts] = useState<string[]>(['', '']);

  useEffect(() => {
    const titles = draft.map((id) => CATALOG_BY_ID[id]?.title).filter(Boolean) as string[];
    if (!titles.length) return;
    setOpts((prev) => {
      const have = new Set(prev.map((x) => x.trim()).filter(Boolean));
      const merged = [...prev.filter((x) => x.trim()), ...titles.filter((t) => !have.has(t))].slice(0, 5);
      while (merged.length < 2) merged.push('');
      return merged;
    });
  }, [draft]);

  const options = opts.map((o) => o.trim()).filter(Boolean);
  const valid = q.trim().length > 0 && options.length >= 2;
  const suggest = () => {
    const pool = [...CATALOG].sort(() => Math.random() - 0.5).slice(0, 3).map((m) => m.title);
    setOpts(pool);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const byTitle = new Map(CATALOG.map((m) => [m.title.toLowerCase(), m.id]));
    getClient()?.send({ t: 'poll_create', question: q.trim(), options: options.map((label) => ({ label, videoId: byTitle.get(label.toLowerCase()) })) });
    onDone();
  };

  return (
    <form className="composer" onSubmit={submit}>
      <label className="field"><span className="field__label">Question</span>
        <input className="field__input" value={q} maxLength={120} onChange={(e) => setQ(e.target.value)} />
      </label>
      <datalist id="catalog-titles">{CATALOG.map((m) => <option key={m.id} value={m.title} />)}</datalist>
      <div className="composer__opts">
        <span className="field__label">Options <em>(type a title from the catalog to queue it if it wins)</em></span>
        {opts.map((o, i) => (
          <input key={i} className="field__input" list="catalog-titles" value={o} maxLength={60} placeholder={`Option ${i + 1}`} aria-label={`Option ${i + 1}`}
            onChange={(e) => setOpts((p) => p.map((x, j) => (j === i ? e.target.value : x)))} />
        ))}
        {opts.length < 5 && <button type="button" className="btn btn--glass btn--sm" onClick={() => setOpts((p) => [...p, ''])}>+ Add option</button>}
        <button type="button" className="btn btn--glass btn--sm" onClick={suggest}>Suggest three titles</button>
      </div>
      <div className="composer__actions">
        <button className="btn btn--butter" type="submit" disabled={!valid}>Start poll</button>
        <button className="btn btn--line" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
