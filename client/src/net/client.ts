import {
  type ClientMsg, type ControlOp, type ServerMsg,
} from '@shared/protocol';
import { estimateOffset, type ClockSample } from '@shared/sync';
import { useRoom } from '../store';
import { Mesh, releaseLocalMedia, shareWasRequested, stopLocalScreen } from './rtc';

/** Backend origin. Empty = same origin (local dev / `npm start`); set VITE_SERVER_URL when the client is hosted separately (e.g. Netlify). */
const SERVER = ((import.meta.env.VITE_SERVER_URL as string | undefined) ?? '').replace(/\/+$/, '');
export const apiUrl = (path: string) => `${SERVER}${path}`;
/** True when the backend is hosted separately (and may be asleep, e.g. Render's free tier). */
export const REMOTE_SERVER = !!SERVER;
/** Resolves true if the server answers its health check within `timeoutMs`. */
export async function pingServer(timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await fetch(apiUrl('/api/health'), { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch { return false; }
}
const wsUrl = () => {
  if (SERVER) return `${SERVER.replace(/^http/, 'ws')}/ws`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
};

export interface Profile { name: string; color: string }

const tokenKey = (code: string) => `wp:token:${code}`;
const safe = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
// The seat token lives in sessionStorage: it survives a refresh/reconnect in this tab,
// but a second tab gets its own seat instead of fighting over this one.
const seat = {
  get(k: string) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
};

// The name is never pre-filled on a fresh visit: it lives in sessionStorage so a refresh
// inside a room keeps your seat, but opening the site again always asks who you are.
try { localStorage.removeItem('wp:profile'); } catch { /* ignore */ }
export function loadProfile(): Profile | null {
  try { return JSON.parse(seat.get('wp:profile') ?? 'null'); } catch { return null; }
}
export function saveProfile(p: Profile) { seat.set('wp:profile', JSON.stringify(p)); }

type Listener = () => void;

/** One websocket to one room: reconnect with backoff, clock sync, typed send. */
export class RoomClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private closedByUs = false;
  private samples: ClockSample[] = [];
  private pingTimer?: number;
  private reconnectTimer?: number;
  private reportTimer?: number;
  private offset = 0;
  private everLive = false;
  /** latest engine report is pulled from here once a second */
  getReport: (() => Omit<Extract<ClientMsg, { t: 'report' }>, 't' | 'rtt'>) | null = null;
  onState: Listener[] = [];
  /** webcams / screen share peers; created once we know our member id */
  mesh: Mesh | null = null;

  constructor(private code: string, private profile: Profile) {}

  serverNow() { return Date.now() + this.offset; }

  /** test hook: sever the socket as a flaky network would */
  dropSocketForTest() { this.ws?.close(); }

  connect() {
    this.closedByUs = false;
    const st = useRoom.getState();
    st.set({ status: this.everLive ? 'reconnecting' : 'connecting' });
    const ws = new WebSocket(wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.send({ t: 'join', code: this.code, name: this.profile.name, color: this.profile.color, token: seat.get(tokenKey(this.code)) ?? undefined });
    };
    ws.onmessage = (ev) => {
      let m: ServerMsg;
      try { m = JSON.parse(ev.data); } catch { return; }
      this.handle(m);
    };
    ws.onclose = (ev) => {
      window.clearInterval(this.pingTimer);
      window.clearInterval(this.reportTimer);
      if (ev.code === 4000 && !this.closedByUs) {
        useRoom.getState().set({ status: 'failed', failMessage: 'This seat was taken over by another window, so this one disconnected. Reload to take it back.' });
        return;
      }
      if (this.closedByUs || useRoom.getState().status === 'failed') return;
      useRoom.setState((s) => ({ status: 'reconnecting', reconnects: this.everLive ? s.reconnects + 1 : s.reconnects }));
      const backoff = Math.min(5000, 300 * 2 ** this.attempt++) * (0.7 + Math.random() * 0.6);
      this.reconnectTimer = window.setTimeout(() => this.connect(), backoff);
    };
    ws.onerror = () => ws.close();
  }

  close() {
    this.closedByUs = true;
    this.mesh?.close();
    this.mesh = null;
    releaseLocalMedia();
    window.clearInterval(this.pingTimer);
    window.clearInterval(this.reportTimer);
    window.clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  send(m: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  control(ctl: ControlOp) {
    const st = useRoom.getState();
    this.send({ t: 'control', id: Math.random().toString(36).slice(2, 9), baseSeq: st.state.seq, sentAt: this.serverNow(), ctl });
  }

  private ping() { this.send({ t: 'ping', c: performance.now() }); }

  private handle(m: ServerMsg) {
    const st = useRoom.getState();
    switch (m.t) {
      case 'welcome': {
        seat.set(tokenKey(this.code), m.token);
        this.attempt = 0;
        this.everLive = true;
        this.offset = m.snap.serverNow - Date.now(); // rough until the first pongs land
        st.hydrate(m.snap);
        st.set({ status: 'live' });
        if (this.mesh && this.mesh.youId !== m.snap.you) { this.mesh.close(); this.mesh = null; }
        this.mesh ??= new Mesh(m.snap.you);
        // the server forgets our camera and screen when the socket drops; tell it again
        {
          const s = useRoom.getState();
          if (s.myAv.cam || s.myAv.mic) this.send({ t: 'av', cam: s.myAv.cam, mic: s.myAv.mic });
          if (s.localScreen && !m.snap.share) this.send({ t: 'share', on: true });
          else if (s.localScreen && m.snap.share?.by !== m.snap.you) stopLocalScreen();
        }
        this.mesh.sync();
        this.samples = [];
        for (let i = 0; i < 6; i++) window.setTimeout(() => this.ping(), i * 120);
        window.clearInterval(this.pingTimer);
        this.pingTimer = window.setInterval(() => this.ping(), 4000);
        window.clearInterval(this.reportTimer);
        this.reportTimer = window.setInterval(() => {
          const r = this.getReport?.();
          if (r) this.send({ t: 'report', ...r, rtt: useRoom.getState().rtt });
        }, 1000);
        this.onState.forEach((f) => f());
        break;
      }
      case 'pong': {
        const t1 = performance.now();
        const rtt = t1 - m.c;
        this.samples.push({ rtt, offset: m.s - (Date.now() - rtt / 2) });
        if (this.samples.length > 14) this.samples.shift();
        const est = estimateOffset(this.samples);
        if (est) {
          this.offset = est.offset;
          useRoom.setState({ offset: est.offset, rtt: est.rtt, clockSamples: this.samples.length });
        }
        break;
      }
      case 'state': {
        const cur = st.state;
        if (m.state.seq < cur.seq || (m.state.seq === cur.seq && m.reason === 'dup')) {
          if (m.reason === 'dup') return;
          return;
        }
        if (m.sentAt && m.by && m.by !== st.youId && m.reason !== 'resync') st.addPropagation(Math.max(0, this.serverNow() - m.sentAt));
        useRoom.setState({ state: m.state });
        if (m.reason === 'pause' || m.reason === 'play' || m.reason === 'seek' || m.reason === 'load') {
          const who = st.members.find((x) => x.id === m.by);
          if (who && who.id !== st.youId && (m.reason === 'load')) st.toast(`${who.name} changed the movie`);
        }
        this.onState.forEach((f) => f());
        break;
      }
      case 'members': st.set({ members: m.members }); this.mesh?.sync(); break;
      case 'meta': useRoom.setState((s) => ({ meta: { ...s.meta, [m.id]: m.meta } })); break;
      case 'subs':
        useRoom.setState((s) => {
          const subs = { ...s.subs };
          if (m.subs) subs[m.videoId] = m.subs; else delete subs[m.videoId];
          return { subs };
        });
        break;
      case 'upload':
        useRoom.setState((s) => ({ uploads: [m.upload, ...s.uploads.filter((u) => u.id !== m.upload.id)].sort((a, b) => b.createdAt - a.createdAt) }));
        break;
      case 'share': {
        const wasMine = st.share?.by === st.youId;
        st.set({ share: m.share });
        // someone else took the screen, or the host stopped ours
        if (st.localScreen && ((m.share && m.share.by !== st.youId) || (!m.share && wasMine))) stopLocalScreen();
        break;
      }
      case 'rtc': this.mesh?.signal(m.from, m.data); break;
      case 'health': st.set({ health: m.health, holding: m.holding }); break;
      case 'chat': st.addChat(m.msg); break;
      case 'typing':
        useRoom.setState((s) => ({ typing: { ...s.typing, [m.from]: Date.now() + 3000 } }));
        break;
      case 'reaction': st.addFloater({ id: m.id, from: m.from, emoji: m.emoji }); break;
      case 'heat': st.set({ heat: m.heat }); break;
      case 'queue': st.set({ queue: m.queue }); break;
      case 'polls': st.set({ polls: m.polls }); break;
      case 'settings': st.set({ settings: m.settings }); break;
      case 'ready': st.set({ ready: m.ready }); this.onState.forEach((f) => f()); break;
      case 'error':
        if (m.fatal) { st.set({ status: 'failed', failMessage: m.message }); this.close(); }
        else {
          if ((m.code === 'busy' || m.code === 'forbidden') && shareWasRequested() && st.share?.by !== st.youId) stopLocalScreen();
          st.toast(m.message, 'error');
        }
        break;
    }
  }
}

/** headers that prove to the HTTP API that we hold a seat in this room */
export function seatHeaders(): Record<string, string> {
  const code = useRoom.getState().code;
  return { 'X-Room': code, 'X-Seat': seat.get(tokenKey(code)) ?? '' };
}

let current: RoomClient | null = null;
export const getClient = () => current;
export function openRoom(code: string, profile: Profile) {
  current?.close();
  useRoom.getState().reset();
  current = new RoomClient(code, profile);
  current.connect();
  return current;
}
export function leaveRoom() {
  current?.close();
  current = null;
  useRoom.getState().reset();
}
