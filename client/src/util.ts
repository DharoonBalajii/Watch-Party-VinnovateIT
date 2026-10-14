import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { expectedPosition } from '@shared/sync';
import { getClient } from './net/client';
import { useRoom } from './store';

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

export function fmtTime(s: number) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
export function fmtRuntime(s: number) {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
export const fmtMs = (s: number) => `${s >= 0 ? '+' : '−'}${Math.round(Math.abs(s) * 1000)} ms`;

export function initials(name: string) {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '?') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

/** Re-render on every animation frame while `active`. Returns a monotonically increasing frame id. */
export function useFrame(active = true) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const loop = () => { set((n) => (n + 1) % 1e9); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);
}

/** The room's authoritative playhead, evaluated now. */
export function roomPosition(duration?: number) {
  const st = useRoom.getState();
  const c = getClient();
  if (!c) return 0;
  return expectedPosition(st.state, c.serverNow(), duration);
}

export function useMedia(query: string) {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(query); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function useClickOutside(ref: React.RefObject<HTMLElement | null>, onOut: () => void, active: boolean) {
  const cb = useRef(onOut);
  cb.current = onOut;
  useEffect(() => {
    if (!active) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) cb.current(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') cb.current(); };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [ref, active]);
}
