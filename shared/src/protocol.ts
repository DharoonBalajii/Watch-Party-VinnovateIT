// Wire protocol shared by server, browser client, load-test bots and tests.
import type { SourceMeta } from './source';

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
  /** sending camera / microphone over WebRTC */
  cam: boolean;
  mic: boolean;
  /** server time of this member's latest (re)connect: a change means their page may have reloaded */
  since: number;
}

/** a subtitle file attached to one source in this room */
export interface SubsInfo {
  id: string;
  label: string;
  by: string;
  cues: number;
}

/** a video someone uploaded into this room (mirrors the server's upload record) */
export interface RoomUpload {
  id: string;
  name: string;
  size: number;
  status: 'uploading' | 'processing' | 'ready' | 'failed';
  progress: number;
  error?: string;
  duration?: number;
  createdAt: number;
  by: string;
}

/** someone's screen is on the room's screen instead of the video */
export interface ScreenShare {
  by: string;
  startedAt: number;
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
  /** locked rooms turn away new viewers; people already in can still reconnect */
  locked: boolean;
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
  share: ScreenShare | null;
  meta: Record<string, SourceMeta>;
  /** videoId → its subtitles */
  subs: Record<string, SubsInfo>;
  uploads: RoomUpload[];
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
  | { t: 'report'; pos: number; drift: number; mode: MemberHealth['mode']; buffering: boolean; rtt: number; duration?: number }
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
  /** host only: remove someone from the room; they can't rejoin from that seat */
  | { t: 'kick'; target: string }
  | { t: 'settings'; settings: Partial<RoomSettings> }
  | { t: 'ready_start' }
  | { t: 'ready'; ready: boolean }
  | { t: 'av'; cam: boolean; mic: boolean }
  | { t: 'share'; on: boolean }
  | { t: 'subs_clear'; videoId: string }
  /** WebRTC signaling, relayed verbatim to one other member */
  | { t: 'rtc'; to: string; data: unknown };

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
  | { t: 'share'; share: ScreenShare | null }
  | { t: 'meta'; id: string; meta: SourceMeta }
  | { t: 'subs'; videoId: string; subs: SubsInfo | null }
  | { t: 'upload'; upload: RoomUpload }
  | { t: 'rtc'; from: string; data: unknown }
  | { t: 'error'; code: string; message: string; fatal?: boolean };

export const MAX_CHAT_LEN = 400;
export const MAX_NAME_LEN = 24;

export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}
export function formatRoomCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}
