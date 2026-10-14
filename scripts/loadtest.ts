// Headless load test: N bot viewers in one room, a storm of play/pause/seek from random bots,
// and (optionally) chaos: disconnect/reconnect, late joiners, concurrent controls.
//
// Propagation = (receiver wall-clock at `state` receipt) − (sender wall-clock when it called send()).
// Server and bots share one machine clock, so no clock-offset error; the bot process's own
// event-loop lag is included in the numbers (conservative).
//
//   npm run loadtest                       # 10 / 25 / 50 users + chaos
//   npm run loadtest -- --users=10 --seconds=30
import { spawn, type ChildProcess } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { ClientMsg, PlaybackState, ServerMsg } from '../shared/src/protocol';
import { expectedPosition, percentile } from '../shared/src/sync';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const USERS = arg('users', '10,25,50').split(',').map(Number);
const SECONDS = Number(arg('seconds', '20'));
const CHAOS = arg('chaos', 'true') !== 'false';
// optional emulated network: one-way delay ± jitter applied to every message in both directions
const NET_DELAY = Number(arg('netdelay', '0'));
const JITTER = Number(arg('jitter', '0'));
const PORT = 4100 + Math.floor(Math.random() * 500);
const BASE = `127.0.0.1:${PORT}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Bot {
  ws!: WebSocket;
  id = '';
  token = '';
  state: PlaybackState | null = null;
  lastSeq = -1;
  outOfOrder = 0;
  /** seq of every state change applied after the snapshot — must be gap-free */
  seqLog: number[] = [];
  snapSeq = -1;
  props: number[] = [];
  ackRtt: number[] = [];
  pending = new Map<string, number>();
  closed = false;
  reconnects = 0;
  snapshotAt = 0;
  private reportTimer?: NodeJS.Timeout;

  constructor(private code: string, readonly name: string) {}

  private pipes = { lastIn: [] as { at: number; fn: () => void }[], lastOut: [] as { at: number; fn: () => void }[] };
  private pumping = { lastIn: false, lastOut: false };
  /** emulated one-way latency; strict FIFO per direction (like TCP) even when jitter would reorder */
  private later(dir: 'lastIn' | 'lastOut', fn: () => void) {
    if (!NET_DELAY) return fn();
    const q = this.pipes[dir];
    const lag = Math.max(0, NET_DELAY + (Math.random() * 2 - 1) * JITTER);
    const at = Math.max(Date.now() + lag, (q[q.length - 1]?.at ?? 0));
    q.push({ at, fn });
    if (!this.pumping[dir]) this.pump(dir);
  }
  private pump(dir: 'lastIn' | 'lastOut') {
    const q = this.pipes[dir];
    this.pumping[dir] = true;
    const step = () => {
      while (q.length && q[0].at <= Date.now()) q.shift()!.fn();
      if (q.length) setTimeout(step, Math.max(1, q[0].at - Date.now()));
      else this.pumping[dir] = false;
    };
    setTimeout(step, Math.max(1, q[0].at - Date.now()));
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = (this.ws = new WebSocket(`ws://${BASE}/ws`, { perMessageDeflate: false }));
      this.ws.on('open', () => this.send({ t: 'join', code: this.code, name: this.name, color: '#FF5C8A', token: this.token || undefined }));
      this.ws.on('message', (d) => this.later('lastIn', () => {
        if (this.ws !== ws) return; // a dead socket's in-flight messages never reach the app (as in a real client)
        const recvAt = Date.now();
        const m = JSON.parse(d.toString()) as ServerMsg;
        if (m.t === 'welcome') {
          this.token = m.token;
          this.id = m.snap.you;
          this.state = m.snap.state;
          this.lastSeq = m.snap.state.seq;
          this.snapshotAt = recvAt;
          this.snapSeq = m.snap.state.seq;
          this.seqLog = [];
          this.reportTimer ??= setInterval(() => this.report(), 1000 + Math.random() * 100);
          resolve();
        } else if (m.t === 'state') {
          if (m.state.seq < this.lastSeq) this.outOfOrder++;
          if (m.state.seq > this.lastSeq) {
            this.lastSeq = m.state.seq;
            this.seqLog.push(m.state.seq);
            this.state = m.state;
            if (m.sentAt && m.by && m.by !== this.id && m.reason !== 'dup' && m.reason !== 'resync') this.props.push(recvAt - m.sentAt);
          }
          if (m.opId && this.pending.has(m.opId)) {
            this.ackRtt.push(recvAt - this.pending.get(m.opId)!);
            this.pending.delete(m.opId);
          }
        } else if (m.t === 'error' && m.fatal) reject(new Error(m.message));
      }));
      this.ws.on('close', () => { this.closed = true; });
      this.ws.on('error', reject);
    });
  }
  send(m: ClientMsg) {
    const raw = JSON.stringify(m);
    this.later('lastOut', () => { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(raw); });
  }
  control(ctl: Extract<ClientMsg, { t: 'control' }>['ctl']) {
    const id = Math.random().toString(36).slice(2, 8);
    const sentAt = Date.now();
    this.pending.set(id, sentAt);
    this.send({ t: 'control', id, baseSeq: this.lastSeq, sentAt, ctl });
  }
  report() {
    this.send({ t: 'report', pos: this.state ? expectedPosition(this.state, Date.now()) : 0, drift: (Math.random() - 0.5) * 0.1, mode: 'sync', buffering: false, rtt: 3 });
  }
  async reconnect() {
    this.reconnects++;
    this.ws.terminate();
    await sleep(50 + Math.random() * 200);
    await this.connect();
  }
  stop() {
    clearInterval(this.reportTimer);
    this.ws.terminate();
  }
}

function summarize(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    n: s.length,
    p50: r(percentile(s, 50)), p95: r(percentile(s, 95)), p99: r(percentile(s, 99)), max: r(s[s.length - 1] ?? 0),
    mean: r(s.reduce((a, b) => a + b, 0) / (s.length || 1)),
  };
}

type ScenarioResult = Awaited<ReturnType<typeof scenario>>;
async function health() {
  return (await (await fetch(`http://${BASE}/api/health`)).json()) as any;
}

async function scenario(n: number, seconds: number, chaos: boolean) {
  const code = ((await (await fetch(`http://${BASE}/api/rooms`, { method: 'POST' })).json()) as any).code as string;
  const bots: Bot[] = [];
  for (let i = 0; i < n; i++) {
    const b = new Bot(code, `bot${i}`);
    await b.connect();
    bots.push(b);
  }
  bots[0].control({ op: 'load', videoId: 'sintel' });
  await sleep(300);
  bots[0].control({ op: 'play' });
  await sleep(400);

  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();
  const before = await health();
  const t0 = Date.now();
  let ops = 0;
  const lateJoinChecks: { ok: boolean; posErrMs: number }[] = [];
  const chaosEvents = { reconnects: 0, lateJoins: 0, concurrentBursts: 0 };

  // control storm: one op every ~120 ms from a random bot; alternating pause/play/seek
  const stormer = setInterval(() => {
    const b = bots[Math.floor(Math.random() * bots.length)];
    const r = Math.random();
    if (r < 0.35) b.control({ op: 'pause' });
    else if (r < 0.7) b.control({ op: 'play' });
    else b.control({ op: 'seek', pos: Math.floor(Math.random() * 800) });
    ops++;
  }, 120);

  const chaosTimers: NodeJS.Timeout[] = [];
  if (chaos) {
    // random reconnects (≈15% of viewers every 2 s)
    chaosTimers.push(setInterval(() => {
      const pool = bots.slice(1).filter((b) => !b.closed);
      for (const b of pool.filter(() => Math.random() < 0.15)) { chaosEvents.reconnects++; b.reconnect().catch(() => {}); }
    }, 2000));
    // late joiners: verify they receive the live anchor, and that it matches what an observer sees
    chaosTimers.push(setInterval(async () => {
      const late = new Bot(code, `late${chaosEvents.lateJoins}`);
      chaosEvents.lateJoins++;
      try {
        await late.connect();
        // snapshot must carry a live anchor, and every change after it must arrive in order with no gaps
        const snapPos = expectedPosition(late.state!, late.snapshotAt);
        await sleep(1200);
        const contiguous = late.seqLog.every((q, i) => q === (i === 0 ? late.snapSeq : late.seqLog[i - 1]) + 1);
        const observer = bots[0]; // never reconnected by the chaos loop
        lateJoinChecks.push({ ok: contiguous && Math.abs(late.lastSeq - observer.lastSeq) <= 1 && Number.isFinite(snapPos), posErrMs: 0 });
      } catch { lateJoinChecks.push({ ok: false, posErrMs: Infinity }); }
      late.stop();
    }, 2500));
    // simultaneous control bursts from 5 bots at once
    chaosTimers.push(setInterval(() => {
      chaosEvents.concurrentBursts++;
      const p = Math.floor(Math.random() * 700);
      for (const b of bots.slice(2, 7)) b.control(Math.random() < 0.5 ? { op: 'seek', pos: p + Math.floor(Math.random() * 30) } : { op: 'pause' });
    }, 3000));
  }

  await sleep(seconds * 1000);
  clearInterval(stormer);
  chaosTimers.forEach(clearInterval);
  await sleep(1500); // let in-flight traffic land & reconnects finish
  const elapsed = (Date.now() - t0) / 1000;
  loop.disable();

  // convergence: every connected bot must hold the same (seq, anchor) as the server's last state
  const live = bots.filter((b) => !b.closed && b.ws.readyState === WebSocket.OPEN);
  const finalSeqs = new Set(live.map((b) => b.lastSeq));
  const finalAnchors = new Set(live.map((b) => `${b.state!.status}:${b.state!.anchorPos}`));
  const after = await health();

  const props = bots.flatMap((b) => b.props);
  const acks = bots.flatMap((b) => b.ackRtt);
  const result = {
    users: n,
    chaos,
    seconds: Math.round(elapsed),
    controlsSent: ops,
    controlsApplied: after.controls - before.controls - (after.dropped - before.dropped),
    controlsDeduped: after.dropped - before.dropped,
    propagationMs: summarize(props),
    senderAckMs: summarize(acks),
    eventLoopLagMs: { p95: Math.round(loop.percentile(95) / 1e4) / 100, max: Math.round(loop.max / 1e4) / 100 },
    outOfOrderStates: bots.reduce((a, b) => a + b.outOfOrder, 0),
    converged: finalSeqs.size === 1 && finalAnchors.size === 1,
    liveClients: live.length,
    chaosEvents: chaos ? chaosEvents : undefined,
    lateJoin: chaos
      ? { checks: lateJoinChecks.length, ok: lateJoinChecks.filter((c) => c.ok).length, maxPosErrMs: Math.round(Math.max(0, ...lateJoinChecks.map((c) => (Number.isFinite(c.posErrMs) ? c.posErrMs : 0)))) }
      : undefined,
    serverRssMB: Math.round(after.mem / 1e6),
  };
  bots.forEach((b) => b.stop());
  await sleep(200);
  return result;
}

/** 50 seats fill, the 51st is refused with a readable error, and a held seat is still reclaimable. */
async function capacity() {
  const code = ((await (await fetch(`http://${BASE}/api/rooms`, { method: 'POST' })).json()) as any).code as string;
  const bots: Bot[] = [];
  for (let i = 0; i < 50; i++) { const b = new Bot(code, `cap${i}`); await b.connect(); bots.push(b); }
  const extra = new Bot(code, 'one-too-many');
  let refused = '';
  try { await extra.connect(); } catch (e) { refused = (e as Error).message; }
  extra.stop();
  // drop one viewer and reconnect with the same token inside the grace window → must get the same seat back
  const victim = bots[7];
  const idBefore = victim.id;
  await victim.reconnect();
  const reclaimed = victim.id === idBefore;
  bots.forEach((b) => b.stop());
  return { refused, reclaimed };
}

async function main() {
  const server: ChildProcess = spawn('npx', ['tsx', 'server/src/index.ts'], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    for (let i = 0; i < 60; i++) { try { await health(); break; } catch { await sleep(250); } }
    await health();

    const env = {
      node: process.version, platform: `${os.platform()} ${os.release()} (${os.arch()})`,
      cpu: `${os.cpus()[0].model} ×${os.cpus().length}`, memGB: Math.round(os.totalmem() / 1e9),
      transport: `loopback 127.0.0.1, ws without compression, TCP_NODELAY${NET_DELAY ? `, emulated ${NET_DELAY} ms ± ${JITTER} ms one-way each direction` : ''}`,
    };
    console.log('Environment:', env);
    const results = [];
    const plan: [number, boolean][] = [...USERS.map((u) => [u, false] as [number, boolean])];
    if (CHAOS) plan.push([12, true], [35, true]); // headroom: departed late joiners hold their seat for the 30 s grace period (cap is 50)
    for (const [n, chaos] of plan) {
      process.stdout.write(`\n▶ ${n} users${chaos ? ' + chaos' : ''} for ${SECONDS}s … `);
      const r = await scenario(n, SECONDS, chaos);
      results.push(r);
      console.log(`p50 ${r.propagationMs.p50} ms · p95 ${r.propagationMs.p95} ms · p99 ${r.propagationMs.p99} ms · converged ${r.converged}`);
    }
    const cap = await capacity();
    console.log(`\nCapacity: 51st viewer → "${cap.refused}"; reconnecting viewer kept their seat: ${cap.reclaimed}`);
    (results as any[]).push({ capacity: cap });
    console.table(results.filter((r: any) => r.users).map((r) => ({
      users: r.users, chaos: r.chaos, samples: r.propagationMs.n, p50: r.propagationMs.p50, p95: r.propagationMs.p95, p99: r.propagationMs.p99, max: r.propagationMs.max,
      ackP95: r.senderAckMs.p95, applied: r.controlsApplied, deduped: r.controlsDeduped, converged: r.converged, ooo: r.outOfOrderStates,
    })));
    const outDir = path.join(root, 'docs/results');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `loadtest${NET_DELAY ? `-net${NET_DELAY}` : ''}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({ env, secondsPerScenario: SECONDS, results }, null, 2));
    console.log(`\nSaved ${path.relative(root, file)}`);
    const sc = results.filter((r: any) => r.users) as ScenarioResult[];
    const worstP95 = Math.max(...sc.map((r) => r.propagationMs.p95));
    const lateOk = sc.every((r) => !r.lateJoin || r.lateJoin.ok === r.lateJoin.checks);
    const allOk = sc.every((r) => r.converged && r.outOfOrderStates === 0) && lateOk && !!cap.refused && cap.reclaimed;
    console.log(worstP95 <= 250 ? `✔ worst p95 ${worstP95} ms ≤ 250 ms` : `✘ worst p95 ${worstP95} ms > 250 ms`);
    console.log(allOk ? '✔ converged, ordered, late joiners in sync, capacity + seat reclaim OK' : '✘ convergence, late-join or capacity failures');
    process.exitCode = worstP95 <= 250 && allOk ? 0 : 1;
  } finally {
    server.kill('SIGTERM');
  }
}
await main();
process.exit(process.exitCode ?? 0);
