// Webcams, microphones and screen sharing: a full mesh of RTCPeerConnections, one per
// pair of viewers, signalled over the room's existing websocket (server relays `rtc`).
//
// Each pair uses "perfect negotiation": either side may renegotiate whenever its tracks
// change, and the lower member id is the polite peer that yields on an offer collision.
// Every connection carries a random `sid`; an offer with a new sid means the other side
// rebuilt its connection (reload, network change), so we rebuild ours to match.
import { apiUrl, getClient } from './client';
import { useRoom } from '../store';

type Label = 'cam' | 'screen';
interface Signal {
  sid: string;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit | null;
  /** stream id → what it is, so the receiver knows a face from a screen */
  labels?: Record<string, Label>;
}

const rid = () => Math.random().toString(36).slice(2, 10);
const FALLBACK_ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

class Peer {
  readonly pc: RTCPeerConnection;
  readonly sid = rid();
  remoteSid: string | null = null;
  makingOffer = false;
  ignoreOffer = false;
  labels: Record<string, Label> = {};
  senders = new Map<MediaStreamTrack, RTCRtpSender>();

  constructor(readonly id: string, readonly polite: boolean, ice: RTCIceServer[], private mesh: Mesh) {
    const pc = new RTCPeerConnection({ iceServers: ice });
    this.pc = pc;
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.send({ description: pc.localDescription!.toJSON(), labels: mesh.labels() });
      } catch (e) {
        console.warn('[rtc] offer failed', e);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onicecandidate = (e) => this.send({ candidate: e.candidate?.toJSON() ?? null });
    pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') pc.restartIce(); };
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream) return;
      const label = this.labels[stream.id] ?? 'cam';
      const publish = () => useRoom.setState((s) => ({ remote: { ...s.remote, [this.id]: { ...s.remote[this.id], [label]: stream } } }));
      publish();
      stream.onremovetrack = publish;
      stream.onaddtrack = publish;
    };
  }

  send(d: Omit<Signal, 'sid'>) {
    getClient()?.send({ t: 'rtc', to: this.id, data: { sid: this.sid, ...d } satisfies Signal });
  }

  /** make our senders match the tracks we're currently publishing */
  syncTracks(want: { track: MediaStreamTrack; stream: MediaStream }[]) {
    if (this.pc.signalingState === 'closed') return;
    for (const { track, stream } of want) {
      if (!this.senders.has(track)) this.senders.set(track, this.pc.addTrack(track, stream));
    }
    for (const [track, sender] of this.senders) {
      if (!want.some((w) => w.track === track)) {
        try { this.pc.removeTrack(sender); } catch { /* already gone */ }
        this.senders.delete(track);
      }
    }
  }

  close() {
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.close();
  }
}

export class Mesh {
  private peers = new Map<string, Peer>();
  /** each member's `since` when we built our connection to them */
  private seen = new Map<string, number>();
  private ice: RTCIceServer[] | null = null;
  private icePromise: Promise<RTCIceServer[]> | null = null;
  /** signals are applied one at a time, in arrival order */
  private chain: Promise<void> = Promise.resolve();

  constructor(readonly youId: string) {}

  private loadIce() {
    this.icePromise ??= fetch(apiUrl('/api/ice'), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { iceServers?: RTCIceServer[] } | null) => (this.ice = j?.iceServers?.length ? j.iceServers : FALLBACK_ICE))
      .catch(() => (this.ice = FALLBACK_ICE));
    return this.icePromise;
  }

  labels(): Record<string, Label> {
    const st = useRoom.getState();
    const out: Record<string, Label> = {};
    if (st.localCam) out[st.localCam.id] = 'cam';
    if (st.localScreen) out[st.localScreen.id] = 'screen';
    return out;
  }

  private wanted() {
    const st = useRoom.getState();
    const out: { track: MediaStreamTrack; stream: MediaStream }[] = [];
    for (const stream of [st.localCam, st.localScreen]) {
      if (stream) for (const track of stream.getTracks()) if (track.readyState === 'live') out.push({ track, stream });
    }
    return out;
  }

  private makePeer(id: string): Peer {
    const p = new Peer(id, this.youId < id, this.ice ?? FALLBACK_ICE, this);
    this.peers.set(id, p);
    return p;
  }

  private dropPeer(id: string) {
    this.peers.get(id)?.close();
    this.peers.delete(id);
    useRoom.setState((s) => {
      if (!s.remote[id]) return {};
      const remote = { ...s.remote };
      delete remote[id];
      return { remote };
    });
  }

  /** call after our tracks or the member list change */
  sync() {
    this.chain = this.chain.then(async () => {
      await this.loadIce();
      const st = useRoom.getState();
      // a member whose socket dropped may have reloaded and lost their side of the call:
      // forget ours too, and offer afresh when they're back
      // (a reload can also be so quick that we never see them disconnected: `since` catches that)
      const present = new Set(st.members.filter((m) => m.connected).map((m) => m.id));
      for (const m of st.members) {
        if (this.peers.has(m.id) && this.seen.has(m.id) && this.seen.get(m.id) !== m.since) this.dropPeer(m.id);
        this.seen.set(m.id, m.since);
      }
      for (const id of [...this.peers.keys()]) if (!present.has(id)) this.dropPeer(id);
      const want = this.wanted();
      for (const m of st.members) {
        if (m.id === this.youId || !m.connected) continue;
        let p = this.peers.get(m.id);
        if (!p && !want.length) continue; // nothing to send; they'll call us if they have something
        p ??= this.makePeer(m.id);
        p.syncTracks(want);
      }
    }).catch((e) => console.warn('[rtc] sync failed', e));
  }

  signal(from: string, data: unknown) {
    const d = data as Signal;
    if (!d || typeof d !== 'object' || typeof d.sid !== 'string') return;
    this.chain = this.chain.then(async () => {
      await this.loadIce();
      let p = this.peers.get(from);
      if (p && p.remoteSid && p.remoteSid !== d.sid) {
        if (d.description?.type !== 'offer') return; // leftovers from a connection they've already replaced
        this.dropPeer(from);
        p = undefined;
      }
      if (!p) {
        if (d.description?.type !== 'offer') return;
        p = this.makePeer(from);
        p.syncTracks(this.wanted());
      }
      p.remoteSid = d.sid;
      if (d.labels) p.labels = { ...p.labels, ...d.labels };
      const pc = p.pc;
      if (d.description) {
        const collision = d.description.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && collision;
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription(d.description);
        if (d.description.type === 'offer') {
          await pc.setLocalDescription();
          p.send({ description: pc.localDescription!.toJSON(), labels: this.labels() });
        }
      } else if (d.candidate !== undefined) {
        try {
          await pc.addIceCandidate(d.candidate ?? undefined);
        } catch (e) {
          if (!p.ignoreOffer) console.warn('[rtc] bad candidate', e);
        }
      }
    }).catch((e) => console.warn('[rtc] signal failed', e));
  }

  close() {
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
  }
}

// ───────── local capture ─────────

function publish() {
  const st = useRoom.getState();
  getClient()?.send({ t: 'av', cam: st.myAv.cam, mic: st.myAv.mic });
  getClient()?.mesh?.sync();
}

function camStream(): MediaStream {
  const st = useRoom.getState();
  if (st.localCam) return st.localCam;
  const s = new MediaStream();
  st.set({ localCam: s });
  return s;
}

function captureError(e: unknown, what: 'camera' | 'microphone' | 'screen') {
  const name = (e as DOMException)?.name;
  const st = useRoom.getState();
  if (name === 'NotAllowedError') st.toast(what === 'screen' ? 'Screen sharing was cancelled or blocked.' : `Your browser blocked the ${what}. Allow it in the address bar, then try again.`, 'error');
  else if (name === 'NotFoundError') st.toast(`No ${what} found on this device.`, 'error');
  else if (!window.isSecureContext) st.toast(`The ${what} only works over https:// or on localhost.`, 'error');
  else st.toast(`Couldn’t start the ${what}.`, 'error');
}

async function setTrack(kind: 'video' | 'audio', on: boolean) {
  const st = useRoom.getState();
  const stream = camStream();
  const cur = kind === 'video' ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0];
  if (on && !cur) {
    if (!navigator.mediaDevices?.getUserMedia) return captureError(new Error('insecure'), kind === 'video' ? 'camera' : 'microphone');
    try {
      const got = await navigator.mediaDevices.getUserMedia(
        kind === 'video'
          ? { video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } } }
          : { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } },
      );
      const track = got.getTracks()[0];
      stream.addTrack(track);
    } catch (e) {
      return captureError(e, kind === 'video' ? 'camera' : 'microphone');
    }
  } else if (!on && cur) {
    cur.stop();
    stream.removeTrack(cur);
  }
  st.set({ myAv: { ...useRoom.getState().myAv, [kind === 'video' ? 'cam' : 'mic']: on } });
  publish();
}

export const toggleCam = () => setTrack('video', !useRoom.getState().myAv.cam);
export const toggleMic = () => setTrack('audio', !useRoom.getState().myAv.mic);

let shareRequested = false;
export const shareWasRequested = () => shareRequested;

export async function startScreenShare() {
  const st = useRoom.getState();
  if (st.share && st.share.by !== st.youId) {
    const who = st.members.find((m) => m.id === st.share!.by);
    return st.toast(`${who?.name ?? 'Someone'} is sharing their screen. Ask them to stop first.`, 'error');
  }
  if (!navigator.mediaDevices?.getDisplayMedia) return st.toast('This browser can’t share its screen. Try Chrome, Edge or Firefox on a computer.', 'error');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
  } catch (e) {
    return captureError(e, 'screen');
  }
  for (const t of stream.getVideoTracks()) {
    t.contentHint = 'motion';
    t.onended = () => stopScreenShare();
  }
  stopLocalScreen();
  useRoom.getState().set({ localScreen: stream });
  shareRequested = true;
  getClient()?.send({ t: 'share', on: true });
  getClient()?.mesh?.sync();
}

/** stop capturing without telling the server (it already knows, or refused) */
export function stopLocalScreen() {
  shareRequested = false;
  const s = useRoom.getState().localScreen;
  if (!s) return;
  s.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  useRoom.getState().set({ localScreen: null });
  getClient()?.mesh?.sync();
}

export function stopScreenShare() {
  stopLocalScreen();
  getClient()?.send({ t: 'share', on: false });
}

/** leaving the room: release the camera, mic and screen */
export function releaseLocalMedia() {
  const st = useRoom.getState();
  st.localCam?.getTracks().forEach((t) => t.stop());
  st.localScreen?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  shareRequested = false;
}
