import { beforeEach, describe, expect, it } from 'vitest';
import { Room, type Conn } from '../src/rooms';
import { COUNTDOWN_MS, PLAY_LEAD_MS, RECONNECT_GRACE_MS, type ClientMsg, type ServerMsg } from '../../shared/src/protocol';
import { expectedPosition } from '../../shared/src/sync';

let clock = 1_000_000;
const now = () => clock;

class FakeConn implements Conn {
  inbox: ServerMsg[] = [];
  closed = false;
  send(raw: string) { this.inbox.push(JSON.parse(raw)); }
  close() { this.closed = true; }
  last<T extends ServerMsg['t']>(t: T) { return [...this.inbox].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined; }
  all<T extends ServerMsg['t']>(t: T) { return this.inbox.filter((m) => m.t === t) as Extract<ServerMsg, { t: T }>[]; }
}

function setup(n = 3) {
  const room = new Room('TEST22', now);
  const conns: FakeConn[] = [];
  const recs = [];
  for (let i = 0; i < n; i++) {
    const c = new FakeConn();
    const rec = room.join(c, { t: 'join', code: 'TEST22', name: `U${i}`, color: '#FF5C8A' })!;
    conns.push(c); recs.push(rec);
  }
  return { room, conns, recs };
}
const ctl = (id: string, c: any, baseSeq = 0): ClientMsg => ({ t: 'control', id, baseSeq, sentAt: clock, ctl: c });

beforeEach(() => { clock = 1_000_000; });

describe('membership', () => {
  it('first joiner is host; snapshot is delivered to the joiner', () => {
    const { room, conns, recs } = setup(2);
    expect(recs[0].isHost).toBe(true);
    expect(recs[1].isHost).toBe(false);
    expect(conns[1].last('welcome')!.snap.members).toHaveLength(2);
    expect(room.connectedCount).toBe(2);
  });
  it('late joiner gets the current playback anchor and history', () => {
    const { room, recs } = setup(2);
    room.handle(recs[0], ctl('a', { op: 'load', videoId: 'sintel' }));
    clock += 100;
    room.handle(recs[0], ctl('b', { op: 'play' }));
    clock += 30_000;
    room.handle(recs[0], { t: 'chat', text: 'hello' });
    const late = new FakeConn();
    room.join(late, { t: 'join', code: 'TEST22', name: 'Late', color: '#FFD84A' });
    const snap = late.last('welcome')!.snap;
    expect(snap.state.status).toBe('playing');
    expect(expectedPosition(snap.state, snap.serverNow)).toBeCloseTo(30.1 - PLAY_LEAD_MS / 1000 + 0.0, 0);
    expect(snap.chat.some((c) => c.text === 'hello')).toBe(true);
  });
  it('reconnect with token reuses identity and host role', () => {
    const { room, conns, recs } = setup(2);
    const token = conns[0].last('welcome')!.token;
    room.disconnect(recs[0].id, conns[0]);
    clock += 5000;
    const again = new FakeConn();
    const rec = room.join(again, { t: 'join', code: 'TEST22', name: 'whoever', color: '#fff', token })!;
    expect(rec.id).toBe(recs[0].id);
    expect(rec.isHost).toBe(true);
    expect(room.members.size).toBe(2);
  });
  it('a stale socket closing after takeover does not mark the member offline', () => {
    const { room, conns, recs } = setup(1);
    const token = conns[0].last('welcome')!.token;
    const fresh = new FakeConn();
    room.join(fresh, { t: 'join', code: 'TEST22', name: 'x', color: '#fff', token });
    room.disconnect(recs[0].id, conns[0]); // old socket's close event arrives late
    expect(room.members.get(recs[0].id)!.conn).toBe(fresh);
  });
  it('removes members after the grace period and transfers host automatically', () => {
    const { room, conns, recs } = setup(3);
    room.disconnect(recs[0].id, conns[0]);
    clock += RECONNECT_GRACE_MS - 1000; room.tick();
    expect(room.members.has(recs[0].id)).toBe(true);
    clock += 2000; room.tick();
    expect(room.members.has(recs[0].id)).toBe(false);
    expect(room.host?.id).toBe(recs[1].id);
    expect(conns[1].last('members')!.members.find((m) => m.id === recs[1].id)!.isHost).toBe(true);
  });
  it('rejects when full', () => {
    const { room } = setup(50);
    const c = new FakeConn();
    expect(room.join(c, { t: 'join', code: 'TEST22', name: 'x', color: '#fff' })).toBeNull();
    expect(c.last('error')!.code).toBe('room_full');
  });
});

describe('playback control', () => {
  it('play is scheduled slightly in the future and broadcast to everyone with the origin timestamp', () => {
    const { room, conns, recs } = setup();
    room.handle(recs[0], ctl('1', { op: 'load', videoId: 'sintel' }));
    clock += 50;
    room.handle(recs[1], ctl('2', { op: 'play' }));
    for (const c of conns) {
      const s = c.last('state')!;
      expect(s.state.status).toBe('playing');
      expect(s.state.anchorServerTime).toBe(clock + PLAY_LEAD_MS);
      expect(s.opId).toBe('2');
    }
  });
  it('is idempotent: two simultaneous plays/pauses produce one state change', () => {
    const { room, recs } = setup();
    room.handle(recs[0], ctl('1', { op: 'load', videoId: 'sintel' }));
    room.handle(recs[0], ctl('2', { op: 'play' }));
    const seq = room.state.seq;
    room.handle(recs[1], ctl('3', { op: 'play' }));
    expect(room.state.seq).toBe(seq);
    clock += 4000;
    room.handle(recs[1], ctl('4', { op: 'pause' }));
    room.handle(recs[2], ctl('5', { op: 'pause' }));
    expect(room.state.status).toBe('paused');
    expect(room.state.seq).toBe(seq + 1);
  });
  it('concurrent seeks are serialized: every client ends on the same, last-applied state', () => {
    const { room, conns, recs } = setup();
    room.handle(recs[0], ctl('1', { op: 'load', videoId: 'sintel' }));
    room.handle(recs[0], ctl('2', { op: 'play' }));
    room.handle(recs[1], ctl('3', { op: 'seek', pos: 100 }));
    room.handle(recs[2], ctl('4', { op: 'seek', pos: 200 }));
    const finals = conns.map((c) => c.last('state')!.state);
    expect(new Set(finals.map((s) => s.seq)).size).toBe(1);
    expect(finals[0].anchorPos).toBe(200);
    // seq strictly increases across every broadcast a client received
    const seqs = conns[0].all('state').map((s) => s.state.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });
  it('clamps absurd seeks and ignores NaN', () => {
    const { room, recs } = setup(1);
    room.handle(recs[0], ctl('1', { op: 'load', videoId: 'sintel' }));
    room.handle(recs[0], ctl('2', { op: 'seek', pos: 9e9 }));
    expect(room.state.anchorPos).toBeLessThan(1000);
    room.handle(recs[0], ctl('3', { op: 'seek', pos: NaN as any }));
    expect(room.state.anchorPos).toBe(0);
  });
  it('rejects unknown titles', () => {
    const { room, conns, recs } = setup(1);
    room.handle(recs[0], ctl('1', { op: 'load', videoId: 'nope' }));
    expect(conns[0].last('error')!.code).toBe('unknown_video');
    expect(room.state.videoId).toBeNull();
  });
  it('host-only mode blocks guests and resyncs them', () => {
    const { room, conns, recs } = setup(2);
    room.handle(recs[0], ctl('1', { op: 'load', videoId: 'sintel' }));
    room.handle(recs[0], { t: 'settings', settings: { controlMode: 'host' } });
    room.handle(recs[1], ctl('2', { op: 'play' }));
    expect(room.state.status).toBe('paused');
    expect(conns[1].last('error')!.code).toBe('forbidden');
    expect(conns[1].last('state')!.reason).toBe('resync');
  });
  it('rate-limits control floods', () => {
    const { room, recs } = setup(1);
    room.handle(recs[0], ctl('0', { op: 'load', videoId: 'sintel' }));
    for (let i = 0; i < 200; i++) room.handle(recs[0], ctl(`s${i}`, { op: 'seek', pos: i }));
    expect(room.state.seq).toBeLessThan(30);
  });
});

describe('ready check + countdown', () => {
  it('starts everyone at the same instant once all are ready', () => {
    const { room, conns, recs } = setup(3);
    room.handle(recs[0], ctl('1', { op: 'load', videoId: 'sintel' }));
    room.handle(recs[0], { t: 'ready_start' });
    expect(conns[2].last('ready')!.ready!.active).toBe(true);
    room.handle(recs[1], { t: 'ready', ready: true });
    expect(room.state.status).toBe('paused');
    room.handle(recs[2], { t: 'ready', ready: true });
    const s = conns[1].last('state')!;
    expect(s.state.status).toBe('playing');
    expect(s.state.anchorServerTime).toBe(clock + COUNTDOWN_MS);
    expect(conns[2].last('ready')!.ready!.startAt).toBe(clock + COUNTDOWN_MS);
  });
  it('fires on timeout even if someone never answers', () => {
    const { room, recs } = setup(3);
    room.handle(recs[0], ctl('1', { op: 'load', videoId: 'sintel' }));
    room.handle(recs[0], { t: 'ready_start' });
    clock += 13_000; room.tick();
    expect(room.state.status).toBe('playing');
  });
  it('a disconnected member no longer blocks the ready check', () => {
    const { room, conns, recs } = setup(3);
    room.handle(recs[0], ctl('1', { op: 'load', videoId: 'sintel' }));
    room.handle(recs[0], { t: 'ready_start' });
    room.handle(recs[1], { t: 'ready', ready: true });
    room.disconnect(recs[2].id, conns[2]);
    expect(room.state.status).toBe('playing');
  });
});

describe('queue, autoplay and polls', () => {
  it('first add loads the video; later adds queue; votes reorder; ended advances once', () => {
    const { room, recs } = setup(3);
    room.handle(recs[0], { t: 'queue_add', videoId: 'sintel' });
    expect(room.state.videoId).toBe('sintel');
    room.handle(recs[0], { t: 'queue_add', videoId: 'big-buck-bunny' });
    room.handle(recs[1], { t: 'queue_add', videoId: 'spring' });
    const spring = room.queue.find((q) => q.videoId === 'spring')!;
    room.handle(recs[2], { t: 'queue_vote', itemId: spring.id });
    expect(room.queue.length).toBe(2);
    // jump to the end and have every client report `ended`
    room.handle(recs[0], ctl('x', { op: 'seek', pos: 880 }));
    room.handle(recs[0], ctl('y', { op: 'play' }));
    clock += 20_000;
    const before = room.state.seq;
    for (const r of recs) room.handle(r, { t: 'ended', videoId: 'sintel' });
    expect(room.state.videoId).toBe('spring'); // two votes beat one
    expect(room.state.seq).toBe(before + 1); // exactly one advance
    expect(room.queue.map((q) => q.videoId)).toEqual(['big-buck-bunny']);
  });
  it('ignores a premature `ended` from a glitchy client', () => {
    const { room, recs } = setup(2);
    room.handle(recs[0], { t: 'queue_add', videoId: 'sintel' });
    room.handle(recs[0], { t: 'queue_add', videoId: 'spring' });
    room.handle(recs[1], { t: 'ended', videoId: 'sintel' });
    expect(room.state.videoId).toBe('sintel');
  });
  it('polls: one vote per member, changeable; closing queues the winner', () => {
    const { room, recs } = setup(3);
    room.handle(recs[0], { t: 'queue_add', videoId: 'sintel' });
    room.handle(recs[0], { t: 'poll_create', question: 'Next?', options: [{ label: 'Spring', videoId: 'spring' }, { label: 'Nosferatu', videoId: 'nosferatu' }] });
    const poll = room.polls[0];
    const [a, b] = poll.options;
    room.handle(recs[0], { t: 'poll_vote', pollId: poll.id, optionId: a.id });
    room.handle(recs[1], { t: 'poll_vote', pollId: poll.id, optionId: a.id });
    room.handle(recs[1], { t: 'poll_vote', pollId: poll.id, optionId: b.id }); // changes mind
    room.handle(recs[2], { t: 'poll_vote', pollId: poll.id, optionId: b.id });
    expect(poll.options.reduce((n, o) => n + o.votes.length, 0)).toBe(3);
    room.handle(recs[2], { t: 'poll_close', pollId: poll.id }); // non-host, non-creator
    expect(poll.open).toBe(true);
    room.handle(recs[0], { t: 'poll_close', pollId: poll.id });
    expect(poll.open).toBe(false);
    expect(poll.winnerOptionId).toBe(b.id);
    expect(room.queue.map((q) => q.videoId)).toEqual(['nosferatu']);
  });
  it('rejects malformed polls', () => {
    const { room, conns, recs } = setup(1);
    room.handle(recs[0], { t: 'poll_create', question: 'x', options: [{ label: 'only one' }] });
    expect(conns[0].last('error')!.code).toBe('bad_poll');
  });
});

describe('host transfer', () => {
  it('only the host can hand over, and only to a connected member', () => {
    const { room, conns, recs } = setup(3);
    room.handle(recs[1], { t: 'host_transfer', to: recs[2].id });
    expect(room.host!.id).toBe(recs[0].id);
    room.handle(recs[0], { t: 'host_transfer', to: recs[2].id });
    expect(room.host!.id).toBe(recs[2].id);
    room.disconnect(recs[1].id, conns[1]);
    room.handle(recs[2], { t: 'host_transfer', to: recs[1].id });
    expect(room.host!.id).toBe(recs[2].id);
  });
});

describe('hold for stragglers', () => {
  it('does not stop the room for a viewer who only just joined', () => {
    const { room, recs } = setup(2);
    room.handle(recs[0], ctl('1', { op: 'load', videoId: 'sintel' }));
    room.handle(recs[0], ctl('2', { op: 'play' }));
    clock += 500;
    room.handle(recs[1], { t: 'report', pos: 0, drift: 0, mode: 'idle', buffering: true, rtt: 5 });
    clock += 1500; room.tick();
    expect(room.state.status).toBe('playing');
    expect(room.autoHeld).toBe(false);
  });
  it('pauses for a buffering member, then resumes with a scheduled start', () => {
    const { room, recs } = setup(3);
    room.handle(recs[0], ctl('1', { op: 'load', videoId: 'sintel' }));
    room.handle(recs[0], ctl('2', { op: 'play' }));
    clock += 6000;
    room.handle(recs[2], { t: 'report', pos: 2, drift: 0, mode: 'sync', buffering: true, rtt: 5 });
    clock += 800; room.tick();
    expect(room.state.status).toBe('paused');
    expect(room.autoHeld).toBe(true);
    room.handle(recs[2], { t: 'report', pos: 2, drift: 0, mode: 'sync', buffering: false, rtt: 5 });
    clock += 100; room.tick();
    clock += 500; room.tick();
    expect(room.state.status).toBe('playing');
    expect(room.autoHeld).toBe(false);
  });
  it('gives up after 15 s so one bad connection cannot freeze the room', () => {
    const { room, recs } = setup(2);
    room.handle(recs[0], ctl('1', { op: 'load', videoId: 'sintel' }));
    room.handle(recs[0], ctl('2', { op: 'play' }));
    clock += 6000;
    room.handle(recs[1], { t: 'report', pos: 0, drift: 0, mode: 'sync', buffering: true, rtt: 5 });
    clock += 1000; room.tick();
    expect(room.autoHeld).toBe(true);
    clock += 16_000; room.tick();
    expect(room.state.status).toBe('playing');
  });
});

describe('chat, reactions & hardening', () => {
  it('sanitises and caps chat, and rate-limits spam', () => {
    const { room, conns, recs } = setup(2);
    room.handle(recs[0], { t: 'chat', text: '  hi\u0000 there  ' });
    expect(conns[1].last('chat')!.msg.text).toBe('hi there');
    room.handle(recs[0], { t: 'chat', text: 'x'.repeat(5000) });
    expect(conns[1].last('chat')!.msg.text.length).toBe(400);
    const before = conns[1].all('chat').length;
    for (let i = 0; i < 50; i++) room.handle(recs[0], { t: 'chat', text: `spam ${i}` });
    expect(conns[1].all('chat').length - before).toBeLessThan(10);
  });
  it('only whitelisted emoji count toward the reaction heat', () => {
    const { room, conns, recs } = setup(2);
    room.handle(recs[0], ctl('1', { op: 'load', videoId: 'sintel' }));
    room.handle(recs[0], { t: 'react', emoji: '😂', pos: 7 });
    room.handle(recs[0], { t: 'react', emoji: '<script>', pos: 7 });
    clock += 1100; room.tick();
    const heat = conns[1].last('heat')!.heat;
    expect(heat).toEqual([{ videoId: 'sintel', bucket: 1, count: 1 }]);
    expect(conns[1].all('reaction')).toHaveLength(1);
  });
});

describe('links, screen share and webrtc relay', () => {
  it('loads a YouTube link, learns its title and broadcasts it', async () => {
    const { setMetaFetcher } = await import('../src/rooms');
    setMetaFetcher(async () => ({ title: 'Fetched title', author: 'Chan' }));
    const { room, conns, recs } = setup(2);
    room.handle(recs[0], ctl('a', { op: 'load', videoId: 'yt:dQw4w9WgXcQ' }));
    expect(room.state.videoId).toBe('yt:dQw4w9WgXcQ');
    await new Promise((r) => setTimeout(r, 0));
    expect(conns[1].last('meta')).toMatchObject({ id: 'yt:dQw4w9WgXcQ', meta: { title: 'Fetched title' } });
  });
  it('rejects ids that are neither catalog titles nor valid links', () => {
    const { room, conns, recs } = setup(1);
    room.handle(recs[0], ctl('a', { op: 'load', videoId: 'url:javascript:alert(1)' }));
    expect(room.state.videoId).toBeNull();
    expect(conns[0].last('error')!.code).toBe('unknown_video');
  });
  it('learns a link’s duration from reports and uses it to judge “ended”', () => {
    const { room, recs } = setup(2);
    room.handle(recs[0], ctl('a', { op: 'load', videoId: 'url:https://cdn.example.com/a.mp4' }));
    room.handle(recs[0], ctl('b', { op: 'play' }));
    room.handle(recs[1], { t: 'report', pos: 0, drift: 0, mode: 'sync', buffering: false, rtt: 10, duration: 600 });
    expect(room.meta.get('url:https://cdn.example.com/a.mp4')?.duration).toBe(600);
    clock += 10_000;
    room.handle(recs[1], { t: 'ended', videoId: 'url:https://cdn.example.com/a.mp4' });
    expect(room.state.status).toBe('playing'); // 10 s into a 600 s video: bogus
  });
  it('screen share pauses the film, blocks a second sharer and ends when the sharer drops', () => {
    const { room, conns, recs } = setup(3);
    room.handle(recs[0], ctl('a', { op: 'load', videoId: 'sintel' }));
    room.handle(recs[0], ctl('b', { op: 'play' }));
    room.handle(recs[1], { t: 'share', on: true });
    expect(room.share?.by).toBe(recs[1].id);
    expect(room.state.status).toBe('paused');
    room.handle(recs[2], { t: 'share', on: true });
    expect(conns[2].last('error')!.code).toBe('busy');
    room.disconnect(recs[1].id, conns[1]);
    expect(room.share).toBeNull();
    expect(conns[0].last('share')!.share).toBeNull();
  });
  it('loading a film takes the screen back from a share', () => {
    const { room, recs } = setup(2);
    room.handle(recs[1], { t: 'share', on: true });
    room.handle(recs[0], ctl('a', { op: 'load', videoId: 'sintel' }));
    expect(room.share).toBeNull();
  });
  it('relays rtc signals only to the named, connected member', () => {
    const { room, conns, recs } = setup(3);
    room.handle(recs[0], { t: 'rtc', to: recs[2].id, data: { sid: 'x', description: { type: 'offer', sdp: 'v=0' } } });
    expect(conns[2].last('rtc')).toMatchObject({ from: recs[0].id, data: { sid: 'x' } });
    expect(conns[1].last('rtc')).toBeUndefined();
    room.handle(recs[0], { t: 'rtc', to: recs[0].id, data: {} });
    expect(conns[0].last('rtc')).toBeUndefined();
  });
  it('broadcasts camera and mic state and clears it on disconnect', () => {
    const { room, conns, recs } = setup(2);
    room.handle(recs[0], { t: 'av', cam: true, mic: false });
    expect(conns[1].last('members')!.members.find((m) => m.id === recs[0].id)).toMatchObject({ cam: true, mic: false });
    room.disconnect(recs[0].id, conns[0]);
    expect(conns[1].last('members')!.members.find((m) => m.id === recs[0].id)!.cam).toBe(false);
  });
});

describe('ICE servers', () => {
  it('falls back to public STUN, and signs short-lived TURN credentials when configured', async () => {
    const { iceServers } = await import('../src/index');
    expect(iceServers({})).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
    const out = iceServers({ TURN_HOST: 'watch.example.com', TURN_SECRET: 's3cret' }, 1_700_000_000_000);
    const turn = out.find((s) => s.username)!;
    expect(turn.username).toBe(`${1_700_000_000 + 12 * 3600}:watchparty`);
    const { createHmac } = await import('node:crypto');
    expect(turn.credential).toBe(createHmac('sha1', 's3cret').update(turn.username!).digest('base64'));
  });
});

describe('host moderation', () => {
  it('host can remove someone; they are told why and can’t rejoin from that seat', () => {
    const { room, conns, recs } = setup(3);
    const token = conns[2].last('welcome')!.token;
    room.handle(recs[0], { t: 'kick', target: recs[2].id });
    expect(room.members.has(recs[2].id)).toBe(false);
    expect(conns[2].last('error')).toMatchObject({ code: 'kicked', fatal: true });
    expect(conns[2].closed).toBe(true);
    expect(conns[1].last('chat')!.msg.text).toMatch(/removed U2/);
    const back = new FakeConn();
    expect(room.join(back, { t: 'join', code: 'TEST22', name: 'U2', color: '#FF5C8A', token })).toBeNull();
    expect(back.last('error')!.code).toBe('kicked');
  });
  it('only the host can remove people, and not themselves', () => {
    const { room, conns, recs } = setup(2);
    room.handle(recs[1], { t: 'kick', target: recs[0].id });
    expect(room.members.has(recs[0].id)).toBe(true);
    expect(conns[1].last('error')!.code).toBe('forbidden');
    room.handle(recs[0], { t: 'kick', target: recs[0].id });
    expect(room.members.has(recs[0].id)).toBe(true);
  });
  it('removing a screen sharer ends the share', () => {
    const { room, recs } = setup(2);
    room.handle(recs[1], { t: 'share', on: true });
    room.handle(recs[0], { t: 'kick', target: recs[1].id });
    expect(room.share).toBeNull();
  });
  it('a locked room turns away newcomers but lets members reconnect', () => {
    const { room, conns, recs } = setup(2);
    const token = conns[1].last('welcome')!.token;
    room.handle(recs[0], { t: 'settings', settings: { locked: true } });
    expect(conns[1].last('settings')!.settings.locked).toBe(true);
    const stranger = new FakeConn();
    expect(room.join(stranger, { t: 'join', code: 'TEST22', name: 'X', color: '#FF5C8A' })).toBeNull();
    expect(stranger.last('error')!.code).toBe('room_locked');
    room.disconnect(recs[1].id, conns[1]);
    const again = new FakeConn();
    expect(room.join(again, { t: 'join', code: 'TEST22', name: 'U1', color: '#FF5C8A', token })).not.toBeNull();
    room.handle(recs[1], { t: 'settings', settings: { locked: false } });
    expect(room.settings.locked).toBe(true); // only the host can unlock
  });
});

describe('uploads and subtitles in a room', () => {
  it('only plays uploads that belong to the room and are ready', async () => {
    const { setUploadLookup } = await import('../src/rooms');
    const up = { id: '0123456789abcdef', name: 'Trip.mp4', size: 10, status: 'processing' as const, progress: 0.5, createdAt: clock, by: 'x' };
    setUploadLookup((id) => (id === up.id ? up : undefined));
    const { room, conns, recs } = setup(2);
    room.handle(recs[0], ctl('a', { op: 'load', videoId: 'up:0123456789abcdef' }));
    expect(room.state.videoId).toBeNull();
    expect(conns[0].last('error')!.code).toBe('not_ready');
    const ready = { ...up, status: 'ready' as const, progress: 1, duration: 90 };
    setUploadLookup(() => ready);
    room.noteUpload(ready);
    expect(conns[1].last('upload')!.upload.status).toBe('ready');
    room.handle(recs[0], ctl('b', { op: 'load', videoId: 'up:0123456789abcdef' }));
    expect(room.state.videoId).toBe('up:0123456789abcdef');
    expect(room.meta.get('up:0123456789abcdef')).toMatchObject({ title: 'Trip.mp4', duration: 90 });
    setUploadLookup(() => undefined);
  });
  it('shares subtitles, serves them by id, and lets the adder remove them', () => {
    const { room, conns, recs } = setup(2);
    const info = room.setSubs('sintel', recs[1], 'English', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n', 1);
    expect(conns[0].last('subs')).toMatchObject({ videoId: 'sintel', subs: { label: 'English' } });
    expect(room.subsVtt(info.id)).toContain('Hi');
    expect(room.memberByToken(conns[1].last('welcome')!.token)?.id).toBe(recs[1].id);
    room.handle(recs[1], { t: 'subs_clear', videoId: 'sintel' });
    expect(conns[0].last('subs')!.subs).toBeNull();
    expect(room.subsVtt(info.id)).toBeUndefined();
  });
});
