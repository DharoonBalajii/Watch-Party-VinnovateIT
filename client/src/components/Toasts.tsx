import { useRoom } from '../store';
import { cx } from '../util';

export function Toasts() {
  const toasts = useRoom((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', t.tone === 'error' && 'toast--error')}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
