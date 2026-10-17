import { parseSourceInput, resolveSource } from '@shared/source';
import { getClient } from './client';
import { selectCanControl, selectSource, useRoom } from '../store';
import { roomPosition } from '../util';

function guard(): boolean {
  const st = useRoom.getState();
  if (!getClient() || st.status !== 'live') return false;
  if (!selectCanControl(st)) {
    st.toast('Only the host can control playback right now.', 'error');
    return false;
  }
  return true;
}

export function togglePlay() {
  const st = useRoom.getState();
  if (!st.state.videoId) { st.set({ discoverOpen: true }); return; }
  if (!guard()) return;
  getClient()!.control({ op: st.state.status === 'playing' ? 'pause' : 'play' });
}

export function seekTo(pos: number) {
  if (!guard()) return;
  const st = useRoom.getState();
  const dur = st.engine.duration || selectSource(st)?.runtime || Infinity;
  getClient()!.control({ op: 'seek', pos: Math.max(0, Math.min(dur, pos)) });
}

export function seekBy(delta: number) {
  const st = useRoom.getState();
  if (!st.state.videoId) return;
  seekTo(roomPosition(st.engine.duration) + delta);
}

export function loadMovie(videoId: string) {
  const st = useRoom.getState();
  if (!selectCanControl(st)) { st.toast('Only the host can change the movie. Add it to the queue instead.', 'error'); return; }
  getClient()?.control({ op: 'load', videoId });
}

export function queueMovie(videoId: string) {
  getClient()?.send({ t: 'queue_add', videoId });
  const st = useRoom.getState();
  const m = resolveSource(videoId, st.meta[videoId]);
  if (m) st.toast(st.state.videoId ? `Queued “${m.title}”` : `Loaded “${m.title}”`);
}

/** Play or queue a pasted YouTube / video-file link. Returns an error message, or null on success. */
export function playLink(input: string, how: 'play' | 'queue'): string | null {
  const parsed = parseSourceInput(input);
  if ('error' in parsed) return parsed.error;
  if (how === 'play') {
    const st = useRoom.getState();
    if (!selectCanControl(st)) return 'Only the host can change what’s playing. Queue it instead.';
    loadMovie(parsed.id);
  } else {
    queueMovie(parsed.id);
  }
  return null;
}

export function sendReaction(emoji: string) {
  getClient()?.send({ t: 'react', emoji, pos: roomPosition(useRoom.getState().engine.duration) });
}

export function startTogether() {
  const st = useRoom.getState();
  if (!st.state.videoId) { st.set({ discoverOpen: true }); return; }
  if (!guard()) return;
  getClient()!.send({ t: 'ready_start' });
}

// Small, read-mostly hook used by the Playwright e2e (scripts/e2e-drift.ts) and handy in devtools.
if (typeof window !== 'undefined') {
  (window as unknown as { __wpApi: unknown }).__wpApi = {
    load: (id: string) => getClient()?.control({ op: 'load', videoId: id }),
    play: () => getClient()?.control({ op: 'play' }),
    pause: () => getClient()?.control({ op: 'pause' }),
    seek: (pos: number) => getClient()?.control({ op: 'seek', pos }),
    startTogether: () => getClient()?.send({ t: 'ready_start' }),
    ready: () => getClient()?.send({ t: 'ready', ready: true }),
    kill: () => getClient()?.dropSocketForTest(),
    youId: () => useRoom.getState().youId,
    status: () => useRoom.getState().status,
    propagation: () => useRoom.getState().propagation,
    serverNow: () => getClient()?.serverNow(),
    seq: () => useRoom.getState().state.seq,
    send: (m: Parameters<NonNullable<ReturnType<typeof getClient>>['send']>[0]) => getClient()?.send(m),
  };
  (window as unknown as { __wpStore: unknown }).__wpStore = () => useRoom.getState();
}
