import { randomBytes } from 'node:crypto';
import {
  AVATAR_COLORS,
  COUNTDOWN_MS,
  EMPTY_ROOM_TTL_MS,
  HEAT_BUCKET_S,
  MAX_CHAT_LEN,
  MAX_MEMBERS,
  MAX_NAME_LEN,
  PLAY_LEAD_MS,
  READY_TIMEOUT_MS,
  REACTION_EMOJI,
  RECONNECT_GRACE_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_DIGITS,
  type ChatMessage,
  type ClientMsg,
  type HeatBucket,
  type Member,
  type MemberHealth,
  type PlaybackState,
  type Poll,
  type QueueItem,
  type ReadyCheck,
  type RoomSettings,
  type ServerMsg,
  type Snapshot,
} from '../../shared/src/protocol';
import { CATALOG_BY_ID } from '../../shared/src/catalog';
import { expectedPosition } from '../../shared/src/sync';
import { RateLimiter } from './limits';

export interface Conn {
  send(raw: string): void;
  close(code?: number, reason?: string): void;
}

interface MemberRec {
  id: string;
  token: string;
  name: string;
  color: string;
  conn: Conn | null;
  isHost: boolean;
  joinedAt: number;
  /** last (re)connect time — a viewer who just arrived is exempt from "hold for stragglers" */
  connectedAt: number;
  disconnectedAt: number | null;
  health: MemberHealth;
  bufferingSince: number | null;
  limiter: RateLimiter;
}

const id8 = () => randomBytes(4).toString('hex');
const clean = (s: unknown, max: number) =>
  typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, '').trim().slice(0, max) : '';

export function generateRoomCode(): string {
  const pick = (set: string, n: number) =>
    Array.from(randomBytes(n), (b) => set[b % set.length]).join('');
  return pick(ROOM_CODE_ALPHABET, 4) + pick(ROOM_CODE_DIGITS, 2);
}

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export class Room {
  readonly code: string;
  readonly createdAt: number;
  state: PlaybackState;
  settings: RoomSettings = { controlMode: 'everyone', holdForStragglers: true };
  members = new Map<string, MemberRec>();
  queue: QueueItem[] = [];
  polls: Poll[] = [];
  chat: ChatMessage[] = [];
  ready: ReadyCheck | null = null;
  /** videoId → bucket → count */
  heat = new Map<string, Map<number, number>>();
  autoHeld = false;
  private heldAt = 0;
  private holdCooldownUntil = 0;
  emptySince: number | null = null;
  private healthDirty = false;
  private heatDirty = false;
  private lastHealthAt = 0;
  private endedHandled = '';
  private resumeAt: number | null = null;
  readonly stats = { controls: 0, dropped: 0 };

  constructor(code: string, private now: () => number = Date.now) {
    this.code = code;
    this.createdAt = now();
    this.state = { videoId: null, status: 'paused', anchorPos: 0, anchorServerTime: now(), seq: 0 };
    this.emptySince = now();
  }

  // ───────── helpers ─────────
  private emit(rec: MemberRec, msg: ServerMsg) {
    rec.conn?.send(JSON.stringify(msg));
  }
  private broadcast(msg: ServerMsg, exceptId?: string) {
    const raw = JSON.stringify(msg);
    for (const m of this.members.values()) if (m.conn && m.id !== exceptId) m.conn.send(raw);
  }
  private publicMember(m: MemberRec): Member {
    return { id: m.id, name: m.name, color: m.color, connected: !!m.conn, isHost: m.isHost, joinedAt: m.joinedAt };
  }
  private memberList(): Member[] {
    return [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((m) => this.publicMember(m));
  }
  private healthMap(): Record<string, MemberHealth> {
    const out: Record<string, MemberHealth> = {};
    for (const m of this.members.values()) out[m.id] = m.health;
    return out;
  }
  private pos(now = this.now()): number {
    return expectedPosition(this.state, now);
  }
  private maxPos(videoId: string | null): number {
    const m = videoId ? CATALOG_BY_ID[videoId] : null;
    return m ? m.runtime * 1.02 + 5 : 0;
  }
  private canControl(m: MemberRec) {
    return this.settings.controlMode === 'everyone' || m.isHost;
  }
  get connectedCount() {
    let n = 0;
    for (const m of this.members.values()) if (m.conn) n++;
    return n;
  }
  get host(): MemberRec | undefined {
    for (const m of this.members.values()) if (m.isHost) return m;
  }

  private sysChat(text: string) {
    const msg: ChatMessage = { id: id8(), from: null, name: 'Room', color: '#B9B8E0', text, at: this.now() };
    this.chat.push(msg);
    if (this.chat.length > 100) this.chat.shift();
    this.broadcast({ t: 'chat', msg });
  }
  private error(rec: MemberRec, code: string, message: string, fatal = false) {
    this.emit(rec, { t: 'error', code, message, fatal });
  }

  private snapshot(forId: string): Snapshot {
    return {
      code: this.code,
      you: forId,
      serverNow: this.now(),
      members: this.memberList(),
      health: this.healthMap(),
      state: this.state,
      settings: this.settings,
      queue: this.sortedQueue(),
      polls: this.polls,
      chat: this.chat,
      ready: this.ready,
      heat: this.heatList(),
      holding: this.autoHeld,
    };
  }
  private heatList(): HeatBucket[] {
    const vid = this.state.videoId;
    const m = vid ? this.heat.get(vid) : null;
    if (!vid || !m) return [];
    return [...m.entries()].map(([bucket, count]) => ({ videoId: vid, bucket, count }));
  }
  private sortedQueue(): QueueItem[] {
    return [...this.queue].sort((a, b) => b.votes.length - a.votes.length || a.addedAt - b.addedAt);
  }

  // ───────── membership ─────────
  join(conn: Conn, msg: Extract<ClientMsg, { t: 'join' }>): MemberRec | null {
    const now = this.now();
    let rec: MemberRec | undefined;
    if (msg.token) rec = [...this.members.values()].find((m) => m.token === msg.token);

    if (rec) {
      // reconnect: take over the slot, drop any stale socket
      const stale = rec.conn;
      rec.conn = conn;
      rec.connectedAt = now;
      const away = rec.disconnectedAt ? now - rec.disconnectedAt : 0;
      rec.disconnectedAt = null;
      if (stale && stale !== conn) stale.close(4000, 'replaced');
      if (away > 8000) this.sysChat(`${rec.name} is back`);
    } else {
      if (this.members.size >= MAX_MEMBERS) {
        conn.send(JSON.stringify({ t: 'error', code: 'room_full', message: `This room is full (${MAX_MEMBERS} viewers).`, fatal: true } satisfies ServerMsg));
        conn.close(4003, 'full');
        return null;
      }
      const color = /^#[0-9a-fA-F]{6}$/.test(msg.color) ? msg.color : AVATAR_COLORS[this.members.size % AVATAR_COLORS.length];
      rec = {
        id: id8(),
        token: randomBytes(12).toString('hex'),
        name: clean(msg.name, MAX_NAME_LEN) || 'Guest',
        color,
        conn,
        isHost: this.members.size === 0 || ![...this.members.values()].some((m) => m.isHost),
        joinedAt: now,
        connectedAt: now,
        disconnectedAt: null,
        health: { pos: 0, drift: 0, mode: 'idle', buffering: false, rtt: 0 },
        bufferingSince: null,
        limiter: new RateLimiter(this.now),
      };
      this.members.set(rec.id, rec);
      this.sysChat(`${rec.name} joined`);
    }
    this.emptySince = null;
    this.emit(rec, { t: 'welcome', token: rec.token, snap: this.snapshot(rec.id) });
    this.broadcast({ t: 'members', members: this.memberList() }, rec.id);
    return rec;
  }

  /** socket closed. `conn` guards against a stale socket closing after a takeover. */
  disconnect(memberId: string, conn: Conn) {
    const rec = this.members.get(memberId);
    if (!rec || rec.conn !== conn) return;
    rec.conn = null;
    rec.disconnectedAt = this.now();
    rec.bufferingSince = null;
    rec.health = { ...rec.health, buffering: false, mode: 'idle' };
    this.healthDirty = true;
    if (this.ready?.active) this.checkReady();
    this.broadcast({ t: 'members', members: this.memberList() });
  }

  private removeMember(rec: MemberRec) {
    this.members.delete(rec.id);
    this.sysChat(`${rec.name} left`);
    if (rec.isHost) this.autoTransferHost('left');
    for (const p of this.polls) for (const o of p.options) o.votes = o.votes.filter((v) => v !== rec.id);
    for (const q of this.queue) q.votes = q.votes.filter((v) => v !== rec.id);
    this.broadcast({ t: 'members', members: this.memberList() });
    this.broadcast({ t: 'polls', polls: this.polls });
    this.broadcast({ t: 'queue', queue: this.sortedQueue() });
    if (this.members.size === 0) this.emptySince = this.now();
    else if (this.ready?.active) this.checkReady();
  }

  private autoTransferHost(why: string) {
    const candidates = [...this.members.values()].filter((m) => !m.isHost);
    const next =
      candidates.filter((m) => m.conn).sort((a, b) => a.joinedAt - b.joinedAt)[0] ??
      candidates.sort((a, b) => a.joinedAt - b.joinedAt)[0];
    for (const m of this.members.values()) m.isHost = false;
    if (next) {
      next.isHost = true;
      this.sysChat(`${next.name} is now the host (${why === 'left' ? 'previous host left' : why})`);
    }
  }

  // ───────── message dispatch ─────────
  handle(rec: MemberRec, msg: ClientMsg) {
    const lim = (k: Parameters<RateLimiter['allow']>[0]) => rec.limiter.allow(k);
    switch (msg.t) {
      case 'ping':
        if (!lim('ping')) return;
        return this.emit(rec, { t: 'pong', c: num(msg.c), s: this.now() });
      case 'control':
        if (!lim('control')) return this.reject(rec, 'rate_limited', 'Slow down, too many playback changes.');
        return this.control(rec, msg);
      case 'report':
        if (!lim('report')) return;
        return this.report(rec, msg);
      case 'ended':
        return this.ended(msg.videoId);
      case 'chat': {
        if (!lim('chat')) return this.error(rec, 'rate_limited', 'You’re sending messages too quickly.');
        const text = clean(msg.text, MAX_CHAT_LEN);
        if (!text) return;
        const m: ChatMessage = { id: id8(), from: rec.id, name: rec.name, color: rec.color, text, at: this.now() };
        this.chat.push(m);
        if (this.chat.length > 100) this.chat.shift();
        return this.broadcast({ t: 'chat', msg: m });
      }
      case 'typing':
        if (!lim('typing')) return;
        return this.broadcast({ t: 'typing', from: rec.id }, rec.id);
      case 'react': {
        if (!lim('react')) return;
        if (!(REACTION_EMOJI as readonly string[]).includes(msg.emoji)) return;
        const expected = this.pos();
        const p = Math.min(Math.max(0, num(msg.pos, expected)), this.maxPos(this.state.videoId) || expected);
        const pos = Math.abs(p - expected) < 10 ? p : expected;
        if (this.state.videoId) {
          const h = this.heat.get(this.state.videoId) ?? new Map<number, number>();
          const b = Math.floor(pos / HEAT_BUCKET_S);
          h.set(b, (h.get(b) ?? 0) + 1);
          this.heat.set(this.state.videoId, h);
          this.heatDirty = true;
        }
        return this.broadcast({ t: 'reaction', id: id8(), from: rec.id, emoji: msg.emoji, pos, videoId: this.state.videoId });
      }
      case 'queue_add':
        if (!lim('other')) return;
        return this.queueAdd(rec, msg.videoId);
      case 'queue_remove': {
        if (!lim('other')) return;
        const it = this.queue.find((q) => q.id === msg.itemId);
        if (!it) return;
        if (!(rec.isHost || it.addedBy === rec.id || this.settings.controlMode === 'everyone')) return this.error(rec, 'forbidden', 'Only the host or the person who added it can remove this.');
        this.queue = this.queue.filter((q) => q.id !== it.id);
        return this.broadcast({ t: 'queue', queue: this.sortedQueue() });
      }
      case 'queue_vote': {
        if (!lim('other')) return;
        const it = this.queue.find((q) => q.id === msg.itemId);
        if (!it) return;
        it.votes = it.votes.includes(rec.id) ? it.votes.filter((v) => v !== rec.id) : [...it.votes, rec.id];
        return this.broadcast({ t: 'queue', queue: this.sortedQueue() });
      }
      case 'queue_play': {
        if (!lim('other')) return;
        if (!this.canControl(rec)) return this.error(rec, 'forbidden', 'Only the host can change what’s playing.');
        const it = this.queue.find((q) => q.id === msg.itemId);
        if (!it) return;
        this.queue = this.queue.filter((q) => q.id !== it.id);
        this.broadcast({ t: 'queue', queue: this.sortedQueue() });
        return this.loadVideo(it.videoId, rec.id, 'queue_play');
      }
      case 'poll_create':
        if (!lim('other')) return;
        return this.pollCreate(rec, msg);
      case 'poll_vote': {
        if (!lim('other')) return;
        const p = this.polls.find((x) => x.id === msg.pollId && x.open);
        if (!p || !p.options.some((o) => o.id === msg.optionId)) return;
        for (const o of p.options) o.votes = o.votes.filter((v) => v !== rec.id);
        p.options.find((o) => o.id === msg.optionId)!.votes.push(rec.id);
        return this.broadcast({ t: 'polls', polls: this.polls });
      }
      case 'poll_close': {
        const p = this.polls.find((x) => x.id === msg.pollId && x.open);
        if (!p) return;
        if (!(rec.isHost || p.createdBy === rec.id)) return this.error(rec, 'forbidden', 'Only the host or the poll’s creator can close it.');
        return this.pollClose(p);
      }
      case 'host_transfer': {
        if (!rec.isHost) return this.error(rec, 'forbidden', 'Only the host can hand over hosting.');
        const to = this.members.get(msg.to);
        if (!to || to.id === rec.id || !to.conn) return this.error(rec, 'bad_target', 'That person isn’t in the room right now.');
        rec.isHost = false;
        to.isHost = true;
        this.sysChat(`${rec.name} made ${to.name} the host`);
        return this.broadcast({ t: 'members', members: this.memberList() });
      }
      case 'settings': {
        if (!rec.isHost) return this.error(rec, 'forbidden', 'Only the host can change room settings.');
        const s = msg.settings ?? {};
        if (s.controlMode === 'host' || s.controlMode === 'everyone') this.settings.controlMode = s.controlMode;
        if (typeof s.holdForStragglers === 'boolean') {
          this.settings.holdForStragglers = s.holdForStragglers;
          if (!s.holdForStragglers && this.autoHeld) this.releaseHold();
        }
        return this.broadcast({ t: 'settings', settings: this.settings });
      }
      case 'ready_start':
        if (!lim('other')) return;
        return this.readyStart(rec);
      case 'ready': {
        if (!this.ready?.active) return;
        const set = new Set(this.ready.ready);
        if (msg.ready) set.add(rec.id);
        else set.delete(rec.id);
        this.ready = { ...this.ready, ready: [...set] };
        this.broadcast({ t: 'ready', ready: this.ready });
        return this.checkReady();
      }
    }
  }

  private reject(rec: MemberRec, code: string, message: string) {
    this.error(rec, code, message);
    this.emit(rec, { t: 'state', state: this.state, by: null, reason: 'resync' });
  }

  // ───────── playback ─────────
  private applyState(next: Omit<PlaybackState, 'seq'>, by: string | null, reason: string, opId?: string, sentAt?: number) {
    this.state = { ...next, seq: this.state.seq + 1 };
    this.endedHandled = '';
    this.broadcast({ t: 'state', state: this.state, by, opId, sentAt, reason });
  }

  private control(rec: MemberRec, msg: Extract<ClientMsg, { t: 'control' }>) {
    const ctl = msg.ctl;
    if (!ctl || typeof ctl !== 'object') return;
    if (!this.canControl(rec)) return this.reject(rec, 'forbidden', 'Only the host can control playback right now.');
    const now = this.now();
    const cur = this.state;
    this.stats.controls++;

    // A manual control during an auto-hold or ready-check takes over.
    if (this.autoHeld) {
      this.autoHeld = false;
      this.resumeAt = null;
    }
    if (this.ready?.active && ctl.op !== 'load') {
      this.ready = null;
      this.broadcast({ t: 'ready', ready: null });
    }

    switch (ctl.op) {
      case 'load': {
        if (typeof ctl.videoId !== 'string' || !CATALOG_BY_ID[ctl.videoId]) return this.reject(rec, 'unknown_video', 'That title isn’t in the catalog.');
        return this.loadVideo(ctl.videoId, rec.id, 'load', msg.id, msg.sentAt);
      }
      case 'play': {
        if (!cur.videoId) return this.reject(rec, 'no_video', 'Pick a movie first.');
        const alreadyPlaying = cur.status === 'playing';
        if (alreadyPlaying) {
          // idempotent: someone else already pressed play; just make sure the sender is in sync
          this.stats.dropped++;
          return this.emit(rec, { t: 'state', state: cur, by: null, opId: msg.id, sentAt: msg.sentAt, reason: 'dup' });
        }
        return this.applyState(
          { videoId: cur.videoId, status: 'playing', anchorPos: this.pos(now), anchorServerTime: now + PLAY_LEAD_MS },
          rec.id, 'play', msg.id, msg.sentAt,
        );
      }
      case 'pause': {
        if (!cur.videoId) return;
        if (cur.status === 'paused') {
          this.stats.dropped++;
          return this.emit(rec, { t: 'state', state: cur, by: null, opId: msg.id, sentAt: msg.sentAt, reason: 'dup' });
        }
        return this.applyState(
          { videoId: cur.videoId, status: 'paused', anchorPos: this.pos(now), anchorServerTime: now },
          rec.id, 'pause', msg.id, msg.sentAt,
        );
      }
      case 'seek': {
        if (!cur.videoId) return;
        const to = Math.min(Math.max(0, num(ctl.pos)), this.maxPos(cur.videoId));
        return this.applyState(
          { videoId: cur.videoId, status: cur.status, anchorPos: to, anchorServerTime: cur.status === 'playing' ? now + PLAY_LEAD_MS : now },
          rec.id, 'seek', msg.id, msg.sentAt,
        );
      }
    }
  }

  private loadVideo(videoId: string, by: string | null, reason: string, opId?: string, sentAt?: number, autoStart = false) {
    const now = this.now();
    this.ready = null;
    this.broadcast({ t: 'ready', ready: null });
    this.applyState(
      autoStart
        ? { videoId, status: 'playing', anchorPos: 0, anchorServerTime: now + COUNTDOWN_MS }
        : { videoId, status: 'paused', anchorPos: 0, anchorServerTime: now },
      by, reason, opId, sentAt,
    );
    if (autoStart) {
      this.ready = { active: false, startedBy: by ?? '', ready: [], deadline: 0, startAt: now + COUNTDOWN_MS };
      this.broadcast({ t: 'ready', ready: this.ready });
    }
    this.broadcast({ t: 'heat', heat: this.heatList() });
  }

  private ended(videoId: string) {
    const cur = this.state;
    if (videoId !== cur.videoId) return;
    const key = `${videoId}:${cur.seq}`;
    if (this.endedHandled === key) return; // 10 clients all report `ended`; first one wins
    // ignore bogus "ended" if the room clock says we're nowhere near the end
    const m = CATALOG_BY_ID[videoId];
    if (m && this.pos() < m.runtime * 0.9) return;
    this.endedHandled = key;
    const next = this.sortedQueue()[0];
    if (next) {
      this.queue = this.queue.filter((q) => q.id !== next.id);
      this.broadcast({ t: 'queue', queue: this.sortedQueue() });
      this.sysChat(`Up next: ${CATALOG_BY_ID[next.videoId]?.title ?? 'next title'}`);
      this.loadVideo(next.videoId, null, 'autoplay', undefined, undefined, true);
      this.endedHandled = `${next.videoId}:${this.state.seq}`;
    } else {
      this.applyState({ videoId: cur.videoId, status: 'paused', anchorPos: m ? m.runtime : this.pos(), anchorServerTime: this.now() }, null, 'ended');
      this.endedHandled = `${videoId}:${this.state.seq}`;
    }
  }

  private report(rec: MemberRec, msg: Extract<ClientMsg, { t: 'report' }>) {
    const modes = ['sync', 'nudge', 'seek', 'idle'];
    const prev = rec.health;
    const buffering = !!msg.buffering;
    rec.health = {
      pos: Math.max(0, num(msg.pos)),
      drift: Math.max(-600, Math.min(600, num(msg.drift))),
      mode: modes.includes(msg.mode) ? msg.mode : 'idle',
      buffering,
      rtt: Math.max(0, Math.min(10000, num(msg.rtt))),
    };
    if (buffering && rec.bufferingSince === null) rec.bufferingSince = this.now();
    if (!buffering) rec.bufferingSince = null;
    if (prev.buffering !== buffering) this.evaluateHold();
    this.healthDirty = true;
  }

  // ───────── hold for stragglers ─────────
  private evaluateHold() {
    const now = this.now();
    // someone who just (re)joined is loading from cold — don't stop the whole room for that
    const settled = (m: MemberRec) => !!m.conn && now - m.connectedAt > 4000;
    const stragglers = [...this.members.values()].filter((m) => settled(m) && m.bufferingSince !== null && now - m.bufferingSince >= 700);
    const anyBuffering = [...this.members.values()].some((m) => settled(m) && m.bufferingSince !== null);
    if (this.settings.holdForStragglers && this.state.status === 'playing' && !this.autoHeld && stragglers.length && !this.ready?.active && now >= this.holdCooldownUntil) {
      this.autoHeld = true;
      this.heldAt = now;
      this.resumeAt = null;
      this.sysChat(`Holding for ${stragglers.map((s) => s.name).join(', ')} to catch up`);
      this.applyState({ videoId: this.state.videoId, status: 'paused', anchorPos: this.pos(now), anchorServerTime: now }, null, 'hold');
    } else if (this.autoHeld && !anyBuffering && this.resumeAt === null) {
      this.resumeAt = now + 400; // everyone's ready; resume shortly (debounced)
    } else if (this.autoHeld && anyBuffering) {
      this.resumeAt = null;
    }
  }
  private releaseHold() {
    this.autoHeld = false;
    this.resumeAt = null;
    if (this.state.status === 'paused' && this.state.videoId) {
      const now = this.now();
      this.applyState({ videoId: this.state.videoId, status: 'playing', anchorPos: this.state.anchorPos, anchorServerTime: now + PLAY_LEAD_MS }, null, 'resume');
    }
  }

  // ───────── ready check / countdown ─────────
  private readyStart(rec: MemberRec) {
    if (!this.canControl(rec)) return this.error(rec, 'forbidden', 'Only the host can start the countdown.');
    if (!this.state.videoId) return this.error(rec, 'no_video', 'Pick a movie first.');
    if (this.ready?.active) return;
    const now = this.now();
    if (this.state.status === 'playing') {
      this.applyState({ videoId: this.state.videoId, status: 'paused', anchorPos: this.pos(now), anchorServerTime: now }, rec.id, 'pause');
    }
    this.ready = { active: true, startedBy: rec.id, ready: [rec.id], deadline: now + READY_TIMEOUT_MS };
    this.broadcast({ t: 'ready', ready: this.ready });
    this.checkReady();
  }
  private checkReady() {
    const r = this.ready;
    if (!r?.active) return;
    const connected = [...this.members.values()].filter((m) => m.conn);
    const allReady = connected.length > 0 && connected.every((m) => r.ready.includes(m.id));
    if (allReady || this.now() >= r.deadline) this.fireCountdown();
  }
  private fireCountdown() {
    const now = this.now();
    const startAt = now + COUNTDOWN_MS;
    const vid = this.state.videoId;
    if (!vid) return;
    this.ready = { ...this.ready!, active: false, startAt };
    this.applyState({ videoId: vid, status: 'playing', anchorPos: this.state.anchorPos, anchorServerTime: startAt }, this.ready.startedBy, 'countdown');
    this.broadcast({ t: 'ready', ready: this.ready });
  }

  // ───────── queue ─────────
  private queueAdd(rec: MemberRec, videoId: string) {
    if (typeof videoId !== 'string' || !CATALOG_BY_ID[videoId]) return this.error(rec, 'unknown_video', 'That title isn’t in the catalog.');
    this.enqueue(videoId, rec.id, rec);
  }
  private enqueue(videoId: string, by: string, rec?: MemberRec) {
    if (!this.state.videoId) return this.loadVideo(videoId, by, 'load');
    if (this.state.videoId === videoId || this.queue.some((q) => q.videoId === videoId)) {
      if (rec) this.error(rec, 'duplicate', 'That title is already playing or queued.');
      return;
    }
    if (this.queue.length >= 30) {
      if (rec) this.error(rec, 'queue_full', 'The queue is full (30 titles).');
      return;
    }
    this.queue.push({ id: id8(), videoId, addedBy: by, votes: [by], addedAt: this.now() });
    this.broadcast({ t: 'queue', queue: this.sortedQueue() });
  }

  // ───────── polls ─────────
  private pollCreate(rec: MemberRec, msg: Extract<ClientMsg, { t: 'poll_create' }>) {
    const question = clean(msg.question, 120);
    const opts = Array.isArray(msg.options) ? msg.options.slice(0, 6) : [];
    const options = opts
      .map((o) => ({
        id: id8(),
        label: clean(o?.label, 60),
        videoId: typeof o?.videoId === 'string' && CATALOG_BY_ID[o.videoId] ? o.videoId : undefined,
        votes: [] as string[],
      }))
      .filter((o) => o.label);
    if (!question || options.length < 2) return this.error(rec, 'bad_poll', 'A poll needs a question and at least two options.');
    if (this.polls.filter((p) => p.open).length >= 3) return this.error(rec, 'too_many_polls', 'Close an open poll before starting another.');
    this.polls.unshift({ id: id8(), question, options, createdBy: rec.id, open: true, createdAt: this.now() });
    if (this.polls.length > 20) this.polls.pop();
    this.broadcast({ t: 'polls', polls: this.polls });
    this.sysChat(`${rec.name} started a poll: ${question}`);
  }
  private pollClose(p: Poll) {
    p.open = false;
    const top = [...p.options].sort((a, b) => b.votes.length - a.votes.length)[0];
    if (top && top.votes.length > 0) {
      p.winnerOptionId = top.id;
      this.sysChat(`Poll closed: “${top.label}” wins with ${top.votes.length} vote${top.votes.length === 1 ? '' : 's'}`);
      if (top.videoId) this.enqueue(top.videoId, p.createdBy);
    } else {
      this.sysChat('Poll closed with no votes');
    }
    this.broadcast({ t: 'polls', polls: this.polls });
  }

  // ───────── periodic work (called ~4×/s by the manager) ─────────
  tick() {
    const now = this.now();
    // ready check deadline / countdown cleanup
    if (this.ready?.active && now >= this.ready.deadline) this.checkReady();
    if (this.ready && !this.ready.active && this.ready.startAt && now > this.ready.startAt + 800) {
      this.ready = null;
      this.broadcast({ t: 'ready', ready: null });
    }
    // grace expiry for disconnected members
    for (const m of [...this.members.values()]) {
      if (!m.conn && m.disconnectedAt !== null && now - m.disconnectedAt > RECONNECT_GRACE_MS) this.removeMember(m);
    }
    // hold evaluation (stragglers crossing the 700 ms threshold, debounced resume)
    if (this.settings.holdForStragglers) this.evaluateHold();
    if (this.autoHeld && this.resumeAt !== null && now >= this.resumeAt) this.releaseHold();
    // never hold the room hostage: resume after 15 s even if someone is still buffering
    if (this.autoHeld && now - this.heldAt > 15000) {
      this.sysChat('Resuming — someone’s connection is slow');
      this.holdCooldownUntil = now + 20000;
      this.releaseHold();
    }
    // batched broadcasts
    if (now - this.lastHealthAt >= 1000) {
      this.lastHealthAt = now;
      if (this.healthDirty) {
        this.healthDirty = false;
        this.broadcast({ t: 'health', health: this.healthMap(), holding: this.autoHeld });
      }
      if (this.heatDirty) {
        this.heatDirty = false;
        this.broadcast({ t: 'heat', heat: this.heatList() });
      }
    }
  }

  get expired() {
    return this.emptySince !== null && this.now() - this.emptySince > EMPTY_ROOM_TTL_MS;
  }
}

export class RoomManager {
  rooms = new Map<string, Room>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private now: () => number = Date.now) {}

  create(): Room {
    let code = generateRoomCode();
    for (let i = 0; this.rooms.has(code) && i < 50; i++) code = generateRoomCode();
    const room = new Room(code, this.now);
    this.rooms.set(code, room);
    return room;
  }
  get(code: string) {
    return this.rooms.get(code);
  }
  start(intervalMs = 250) {
    this.timer = setInterval(() => {
      for (const [code, room] of this.rooms) {
        room.tick();
        if (room.expired) this.rooms.delete(code);
      }
    }, intervalMs);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
