// Wire protocol shared by server, browser client, load-test bots and tests.

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O
export const ROOM_CODE_DIGITS = '23456789';

export const MAX_MEMBERS = 50;
export const PLAY_LEAD_MS = 180; // play/seek-while-playing take effect this far in the future
export const COUNTDOWN_MS = 3200; // film-leader countdown length
export const READY_TIMEOUT_MS = 12000;
export const RECONNECT_GRACE_MS = 30000;
export const HOST_ABSENT_TRANSFER_MS = 30000;
export const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;

export const REACTION_EMOJI = ['😂', '😮', '❤️', '👏', '🔥', '😭', '🍿'] as const;
export const AVATAR_COLORS = ['#FF5C8A', '#FFD84A', '#4EE6B5', '#6FA8FF', '#B58BFF', '#FF9A4D'] as const;

export type ControlMode = 'host' | 'everyone';

export interface PlaybackState {
  videoId: string | null;
  status: 'playing' | 'paused';
  /** media position (seconds) at anchorServerTime */
  anchorPos: number;
  /** server epoch ms at which anchorPos is valid (may be slightly in the future) */
  anchorServerTime: number;
  /** increments on every applied change; clients drop anything older */
  seq: number;
}

export interface Member {
  id: string;
  name: string;
  color: string;
  connected: boolean;
  isHost: boolean;
  joinedAt: number;
}

export interface MemberHealth {
  pos: number; // last reported media position (s)
  drift: number; // seconds, + = ahead of room
  mode: 'sync' | 'nudge' | 'seek' | 'idle';
  buffering: boolean;
  rtt: number; // ms
}

export interface ChatMessage {
  id: string;
  from: string | null; // null = system
  name: string;
  color: string;
  text: string;
  at: number;
}

export interface QueueItem {
  id: string;
  videoId: string;
  addedBy: string;
  votes: string[]; // member ids
  addedAt: number;
}

export interface PollOption {
  id: string;
  label: string;
  videoId?: string;
  votes: string[];
}

export interface Poll {
  id: string;
  question: string;
  options: PollOption[];
  createdBy: string;
  open: boolean;
  createdAt: number;
  winnerOptionId?: string;
}

export interface RoomSettings {
  controlMode: ControlMode;
  holdForStragglers: boolean;
}

export interface ReadyCheck {
  active: boolean;
  startedBy: string;
  ready: string[];
  deadline: number; // server ms
  /** set once everyone is ready or the deadline passes */
  startAt?: number;
}

export interface HeatBucket {
  videoId: string;
  bucket: number; // floor(pos / HEAT_BUCKET_S)
  count: number;
}
export const HEAT_BUCKET_S = 5;

export interface Snapshot {
  code: string;
  you: string;
  serverNow: number;
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
}

// ───────── client → server ─────────
export type ControlOp =
  | { op: 'play' }
  | { op: 'pause' }
  | { op: 'seek'; pos: number }
  | { op: 'load'; videoId: string };

export type ClientMsg =
  | { t: 'join'; code: string; name: string; color: string; token?: string }
  | { t: 'ping'; c: number }
  | { t: 'control'; id: string; baseSeq: number; sentAt: number; ctl: ControlOp }
  | { t: 'report'; pos: number; drift: number; mode: MemberHealth['mode']; buffering: boolean; rtt: number }
  | { t: 'ended'; videoId: string }
  | { t: 'chat'; text: string }
  | { t: 'typing' }
  | { t: 'react'; emoji: string; pos: number }
  | { t: 'queue_add'; videoId: string }
  | { t: 'queue_remove'; itemId: string }
  | { t: 'queue_vote'; itemId: string }
  | { t: 'queue_play'; itemId: string }
  | { t: 'poll_create'; question: string; options: { label: string; videoId?: string }[] }
  | { t: 'poll_vote'; pollId: string; optionId: string }
  | { t: 'poll_close'; pollId: string }
  | { t: 'host_transfer'; to: string }
  | { t: 'settings'; settings: Partial<RoomSettings> }
  | { t: 'ready_start' }
  | { t: 'ready'; ready: boolean };

// ───────── server → client ─────────
export type ServerMsg =
  | { t: 'welcome'; token: string; snap: Snapshot }
  | { t: 'pong'; c: number; s: number }
  | { t: 'state'; state: PlaybackState; by: string | null; opId?: string; sentAt?: number; reason: string }
  | { t: 'members'; members: Member[] }
  | { t: 'health'; health: Record<string, MemberHealth>; holding: boolean }
  | { t: 'chat'; msg: ChatMessage }
  | { t: 'typing'; from: string }
  | { t: 'reaction'; id: string; from: string; emoji: string; pos: number; videoId: string | null }
  | { t: 'heat'; heat: HeatBucket[] }
  | { t: 'queue'; queue: QueueItem[] }
  | { t: 'polls'; polls: Poll[] }
  | { t: 'settings'; settings: RoomSettings }
  | { t: 'ready'; ready: ReadyCheck | null }
  | { t: 'error'; code: string; message: string; fatal?: boolean };

export const MAX_CHAT_LEN = 400;
export const MAX_NAME_LEN = 24;

export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}
export function formatRoomCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}
