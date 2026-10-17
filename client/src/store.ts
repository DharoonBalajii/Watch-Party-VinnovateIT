import { useMemo } from 'react';
import { create } from 'zustand';
import type {
  ChatMessage, HeatBucket, Member, MemberHealth, PlaybackState, Poll, QueueItem, ReadyCheck, RoomSettings, RoomUpload, ScreenShare, Snapshot, SubsInfo,
} from '@shared/protocol';
import { resolveSource, type Source, type SourceMeta } from '@shared/source';
import { percentile } from '@shared/sync';

export type ConnStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'failed';

export interface Floater { id: string; from: string; emoji: string }
export interface Toast { id: number; text: string; tone: 'info' | 'error' }
export type RailTab = 'chat' | 'queue' | 'polls';

export type DiscoverMode = 'browse' | 'link' | 'upload';
export type YtQuality = 'auto' | 'hd1080' | 'hd720' | 'large';
const pref = <T extends string>(k: string, d: T): T => { try { return (localStorage.getItem(k) as T) || d; } catch { return d; } };

export interface Engine {
  drift: number; // seconds
  mode: 'sync' | 'nudge' | 'seek' | 'idle';
  buffering: boolean;
  pos: number;
  duration: number;
  needsGesture: boolean;
  corrections: number;
  seeks: number;
}

/** what a member is sending us over WebRTC */
export interface RemoteMedia { cam?: MediaStream; screen?: MediaStream }

interface RoomStore {
  status: ConnStatus;
  failMessage: string;
  code: string;
  youId: string;
  members: Member[];
  health: Record<string, MemberHealth>;
  state: PlaybackState;
  settings: RoomSettings;
  queue: QueueItem[];
  polls: Poll[];
  chat: ChatMessage[];
  ready: ReadyCheck | null;
  heat: HeatBucket[];
  holding: boolean;
  share: ScreenShare | null;
  meta: Record<string, SourceMeta>;
  subs: Record<string, SubsInfo>;
  uploads: RoomUpload[];
  /** this viewer's caption toggle and preferred YouTube quality */
  ccOn: boolean;
  ytQuality: YtQuality;
  /** our own camera/mic and screen captures */
  localCam: MediaStream | null;
  localScreen: MediaStream | null;
  /** what we've asked to send (flips immediately; the server echoes it on our Member) */
  myAv: { cam: boolean; mic: boolean };
  remote: Record<string, RemoteMedia>;
  rtt: number;
  offset: number;
  clockSamples: number;
  propagation: number[];
  typing: Record<string, number>;
  floaters: Floater[];
  toasts: Toast[];
  engine: Engine;
  tab: RailTab;
  unread: number;
  discoverOpen: boolean;
  /** which Discover tab is open: films, YouTube, or uploads */
  discoverMode: DiscoverMode;
  pollDraft: string[];
  reconnects: number;

  reset(): void;
  hydrate(s: Snapshot): void;
  set: (p: Partial<RoomStore>) => void;
  addChat(m: ChatMessage): void;
  toast(text: string, tone?: Toast['tone']): void;
  dismissToast(id: number): void;
  addFloater(f: Floater): void;
  removeFloater(id: string): void;
  addPropagation(ms: number): void;
  setTab(t: RailTab): void;
}

const emptyState: PlaybackState = { videoId: null, status: 'paused', anchorPos: 0, anchorServerTime: 0, seq: 0 };
const emptyEngine: Engine = { drift: 0, mode: 'idle', buffering: false, pos: 0, duration: 0, needsGesture: false, corrections: 0, seeks: 0 };

const initial = () => ({
  status: 'idle' as ConnStatus,
  failMessage: '',
  code: '',
  youId: '',
  members: [] as Member[],
  health: {} as Record<string, MemberHealth>,
  state: emptyState,
  settings: { controlMode: 'everyone', holdForStragglers: true, locked: false } as RoomSettings,
  queue: [] as QueueItem[],
  polls: [] as Poll[],
  chat: [] as ChatMessage[],
  ready: null as ReadyCheck | null,
  heat: [] as HeatBucket[],
  holding: false,
  share: null as ScreenShare | null,
  meta: {} as Record<string, SourceMeta>,
  subs: {} as Record<string, SubsInfo>,
  uploads: [] as RoomUpload[],
  ccOn: pref('wp:cc', 'on') === 'on',
  ytQuality: (['auto', 'hd1080', 'hd720', 'large'] as string[]).includes(pref('wp:ytq', 'auto')) ? pref<YtQuality>('wp:ytq', 'auto') : 'auto',
  localCam: null as MediaStream | null,
  localScreen: null as MediaStream | null,
  myAv: { cam: false, mic: false },
  remote: {} as Record<string, RemoteMedia>,
  rtt: 0,
  offset: 0,
  clockSamples: 0,
  propagation: [] as number[],
  typing: {} as Record<string, number>,
  floaters: [] as Floater[],
  toasts: [] as Toast[],
  engine: emptyEngine,
  tab: 'chat' as RailTab,
  unread: 0,
  discoverOpen: false,
  discoverMode: 'browse' as DiscoverMode,
  pollDraft: [] as string[],
  reconnects: 0,
});

let toastId = 1;

export const useRoom = create<RoomStore>((set, get) => ({
  ...initial(),
  reset: () => set(initial()),
  set: (p) => set(p),
  hydrate: (s) =>
    set({
      code: s.code, youId: s.you, members: s.members, health: s.health, state: s.state, settings: s.settings,
      queue: s.queue, polls: s.polls, chat: s.chat, ready: s.ready, heat: s.heat, holding: s.holding,
      share: s.share, meta: s.meta, subs: s.subs ?? {}, uploads: s.uploads ?? [],
    }),
  addChat: (m) =>
    set((st) => ({
      chat: [...st.chat.slice(-199), m],
      unread: st.tab === 'chat' || m.from === st.youId ? st.unread : st.unread + 1,
    })),
  toast: (text, tone = 'info') => {
    const id = toastId++;
    set((st) => ({ toasts: [...st.toasts.slice(-3), { id, text, tone }] }));
    setTimeout(() => get().dismissToast(id), 4200);
  },
  dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
  addFloater: (f) => {
    set((st) => ({ floaters: [...st.floaters.slice(-40), f] }));
    setTimeout(() => get().removeFloater(f.id), 2800);
  },
  removeFloater: (id) => set((st) => ({ floaters: st.floaters.filter((f) => f.id !== id) })),
  addPropagation: (ms) => set((st) => ({ propagation: [...st.propagation.slice(-79), ms] })),
  setTab: (tab) => set((st) => ({ tab, unread: tab === 'chat' ? 0 : st.unread })),
}));

export function propagationStats(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), max: s[s.length - 1] };
}

export const selectMe = (s: RoomStore) => s.members.find((m) => m.id === s.youId);
export const selectCanControl = (s: RoomStore) => {
  const me = s.members.find((m) => m.id === s.youId);
  return !!me && (s.settings.controlMode === 'everyone' || me.isHost);
};

/** the source on screen, resolved with whatever the server has learned about it */
export const selectSource = (s: { state: PlaybackState; meta: Record<string, SourceMeta> }): Source | null =>
  resolveSource(s.state.videoId, s.state.videoId ? s.meta[s.state.videoId] : undefined);

/** React hooks around resolveSource: memoised so components don't re-render in a loop */
export function useSourceById(id: string | null | undefined): Source | null {
  const meta = useRoom((s) => (id ? s.meta[id] : undefined));
  return useMemo(() => resolveSource(id, meta), [id, meta]);
}
export function useCurrentSource(): Source | null {
  return useSourceById(useRoom((s) => s.state.videoId));
}
