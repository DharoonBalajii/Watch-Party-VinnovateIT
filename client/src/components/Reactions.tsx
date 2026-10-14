import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { REACTION_EMOJI } from '@shared/protocol';
import { sendReaction } from '../net/controls';
import { useRoom } from '../store';

export function EmojiBar() {
  const [last, setLast] = useState<string | null>(null);
  const fire = (e: string) => { sendReaction(e); setLast(e); window.setTimeout(() => setLast(null), 180); };
  useEffect(() => {
    const h = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      if (t.closest('input, textarea, [contenteditable]') || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const i = Number(ev.key) - 1;
      if (i >= 0 && i < REACTION_EMOJI.length) fire(REACTION_EMOJI[i]);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  return (
    <div className="emojibar" role="group" aria-label="Send a reaction">
      {REACTION_EMOJI.map((e, i) => (
        <button key={e} className={`emoji${last === e ? ' is-hit' : ''}`} onClick={() => fire(e)} aria-label={`React ${e}`} title={`Press ${i + 1}`}>
          <span>{e}</span>
        </button>
      ))}
    </div>
  );
}

/** Reactions rise from the seat of whoever sent them. */
export function FloatingReactions({ containerRef }: { containerRef: React.RefObject<HTMLElement | null> }) {
  const floaters = useRoom((s) => s.floaters);
  const [xs, setXs] = useState<Record<string, { x: number; sway: number; dur: number }>>({});
  const seen = useRef(new Set<string>());

  useLayoutEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const next: Record<string, { x: number; sway: number; dur: number }> = {};
    let dirty = false;
    for (const f of floaters) {
      if (seen.current.has(f.id)) continue;
      seen.current.add(f.id);
      const seat = c.querySelector<HTMLElement>(`[data-seat="${f.from}"]`);
      const cr = c.getBoundingClientRect();
      const sr = seat?.getBoundingClientRect();
      next[f.id] = { x: sr ? sr.left + sr.width / 2 - cr.left : cr.width * (0.2 + Math.random() * 0.6), sway: (Math.random() - 0.5) * 60, dur: 2.1 + Math.random() * 0.7 };
      dirty = true;
    }
    if (dirty) setXs((p) => ({ ...p, ...next }));
  }, [floaters, containerRef]);

  return (
    <div className="floaters" aria-hidden>
      {floaters.map((f) =>
        xs[f.id] === undefined ? null : (
          <span key={f.id} className="floater" style={{ left: xs[f.id].x, ['--sway' as string]: `${xs[f.id].sway}px`, ['--dur' as string]: `${xs[f.id].dur}s` }}>
            {f.emoji}
          </span>
        ),
      )}
    </div>
  );
}
