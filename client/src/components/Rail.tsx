import { useRoom, type RailTab } from '../store';
import { cx } from '../util';
import { Chat } from './Chat';
import { Polls } from './Polls';
import { Queue } from './Queue';

export function Rail() {
  const tab = useRoom((s) => s.tab);
  const unread = useRoom((s) => s.unread);
  const queueN = useRoom((s) => s.queue.length);
  const openPolls = useRoom((s) => s.polls.filter((p) => p.open).length);
  const setTab = useRoom((s) => s.setTab);
  const tabs: { id: RailTab; label: string; n: number }[] = [
    { id: 'chat', label: 'Chat', n: unread },
    { id: 'queue', label: 'Queue', n: queueN },
    { id: 'polls', label: 'Polls', n: openPolls },
  ];
  return (
    <aside className="rail" aria-label="Room panels">
      <div className="rail__tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} className={cx(tab === t.id && 'is-on')} onClick={() => setTab(t.id)}>
            {t.label}
            {t.n > 0 && <span className={cx('rail__badge mono', t.id === 'chat' && 'rail__badge--hot')}>{t.n}</span>}
          </button>
        ))}
      </div>
      <div className="rail__panel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'chat' && <Chat />}
        {tab === 'queue' && <Queue />}
        {tab === 'polls' && <Polls />}
      </div>
    </aside>
  );
}
