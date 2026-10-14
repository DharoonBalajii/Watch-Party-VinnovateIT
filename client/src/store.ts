import { create } from 'zustand';
import type {
  ChatMessage, HeatBucket, Member, MemberHealth, PlaybackState, Poll, QueueItem, ReadyCheck, RoomSettings, Snapshot,
} from '@shared/protocol';
import { percentile } from '@shared/sync';

export type ConnStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'failed';

export interface Floater { id: string; from: string; emoji: string }
export interface Toast { id: number; text: string; tone: 'info' | 'error' }
export type RailTab = 'chat' | 'queue' | 'polls';

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
  settings: { controlMode: 'everyone', holdForStragglers: true } as RoomSettings,
  queue: [] as QueueItem[],
  polls: [] as Poll[],
  chat: [] as ChatMessage[],
  ready: null as ReadyCheck | null,
  heat: [] as HeatBucket[],
  holding: false,
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
