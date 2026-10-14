// Real-browser end-to-end test: N Chrome pages, each with a real <video>, in one room.
// Measures what the headless load test can't: actual playback drift and recovery.
//
//   npm run build && npm run e2e            # 10 pages
//   npm run e2e -- --pages=12 --headed
//
// Requires Google Chrome (H.264). The catalog's remote video is swapped for a local clip
// (server/media/test-clip.mp4) via request interception so the test is fast and repeatable.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import { percentile } from '../shared/src/sync';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const PAGES = Number(arg('pages', '10'));
const HEADED = process.argv.includes('--headed');
const PORT = 4600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const CLIP = path.join(root, 'server/media/test-clip.mp4');
const MOVIE = 'caminandes-llama-drama';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name} — ${detail}`);
};
const r1 = (n: number) => Math.round(n * 10) / 10;

interface Sample { t: number; drift: number; mode: string; paused: boolean }

async function main() {
  if (!fs.existsSync(path.join(root, 'client/dist/index.html'))) throw new Error('Build the client first: npm run build');
  if (!fs.existsSync(CLIP)) throw new Error('Missing server/media/test-clip.mp4 (see docs/LATENCY.md → "Re-running")');
  const clip = fs.readFileSync(CLIP);

  const server: ChildProcess = spawn('npx', ['tsx', 'server/src/index.ts'], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'inherit'] });
  const browser = await chromium.launch({ channel: 'chrome', headless: !HEADED, args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* starting */ } await sleep(250); }
    const code = ((await (await fetch(`${BASE}/api/rooms`, { method: 'POST' })).json()) as { code: string }).code;

    const context = await browser.newContext({ viewport: { width: 640, height: 720 } });
    // serve the local clip (with Range support) in place of the remote movie
    await context.route(/archive\.org\/download\/Caminandes1LlamaDrama/, async (route) => {
      const range = route.request().headers()['range'];
      const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' };
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range)!;
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), clip.length - 1) : clip.length - 1;
        await route.fulfill({ status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${clip.length}`, 'content-length': String(end - start + 1) }, body: clip.subarray(start, end + 1) });
      } else {
        await route.fulfill({ status: 200, headers: { ...headers, 'content-length': String(clip.length) }, body: clip });
      }
    });

    const open = async (i: number): Promise<Page> => {
      const page = await context.newPage();
      await page.addInitScript(([n]) => {
        localStorage.setItem('wp:profile', JSON.stringify({ name: n, color: '#4EE6B5' }));
        // in-page drift sampler (wall clock, so pages can be compared)
        (window as any).__samples = [];
        setInterval(() => {
          const w = (window as any).__wp;
          if (w) (window as any).__samples.push({ t: performance.timeOrigin + performance.now(), drift: w.drift, mode: w.mode, paused: w.paused });
        }, 50);
      }, [`Viewer ${i + 1}`]);
      await page.goto(`${BASE}/r/${code}`);
      await page.waitForFunction(() => (window as any).__wpApi?.status() === 'live', null, { timeout: 15000 });
      return page;
    };
    const api = <T>(p: Page, fn: string, ...a: unknown[]) => p.evaluate(([f, args]) => (window as any).__wpApi[f as string](...(args as unknown[])), [fn, a]) as Promise<T>;
    const samples = (p: Page) => p.evaluate(() => (window as any).__samples as Sample[]);
    const clear = (ps: Page[]) => Promise.all(ps.map((p) => p.evaluate(() => { (window as any).__samples.length = 0; })));
    const stat = (xs: number[]) => { const s = [...xs].map(Math.abs).sort((a, b) => a - b); return { n: s.length, p50: r1(percentile(s, 50) * 1000), p95: r1(percentile(s, 95) * 1000), max: r1((s[s.length - 1] ?? 0) * 1000) }; };

    // ── join N viewers
    const t0 = Date.now();
    const pages: Page[] = [];
    for (let i = 0; i < PAGES; i++) pages.push(await open(i));
    await pages[0].waitForFunction((n) => document.querySelectorAll('.seat').length >= n, PAGES, { timeout: 15000 });
    check(`${PAGES} viewers joined one room`, true, `${Date.now() - t0} ms for all pages`);

    // ── load + "Start together" (ready check → 3-2-1 → synchronized start)
    await api(pages[0], 'load', MOVIE);
    await Promise.all(pages.map((p) => p.waitForFunction(() => document.querySelector('video')?.readyState! >= 3, null, { timeout: 20000 })));
    await api(pages[0], 'startTogether');
    await sleep(300);
    await Promise.all(pages.map((p) => api(p, 'ready')));
    await Promise.all(pages.map((p) => p.waitForFunction(() => { const w = (window as any).__wp; return w && !w.paused && w.state.status === 'playing' && w.exp > 0.3; }, null, { timeout: 15000 })));
    check('synchronized start after countdown', true, 'every page playing past 0.3 s');

    // ── 1. steady-state drift
    await sleep(2500);
    await clear(pages);
    await sleep(9000);
    const steady = (await Promise.all(pages.map(samples))).flat().filter((s) => !s.paused).map((s) => s.drift);
    const st1 = stat(steady);
    check('steady-state drift ≤ 500 ms', st1.max <= 500, `|drift| p50 ${st1.p50} ms · p95 ${st1.p95} ms · max ${st1.max} ms over ${st1.n} samples`);

    // ── 2. control propagation in real browsers (synced clocks)
    await api(pages[0], 'seek', 4);
    const t = Date.now();
    for (let i = 0; i < 24; i++) {
      const p = pages[i % pages.length];
      await api(p, i % 3 === 0 ? 'pause' : i % 3 === 1 ? 'play' : 'seek', 3 + (i % 5));
      await sleep(180);
    }
    await api(pages[0], 'play');
    await sleep(1200);
    const prop = (await Promise.all(pages.map((p) => api<number[]>(p, 'propagation')))).flat().sort((a, b) => a - b);
    check('control propagation p95 ≤ 250 ms (browser to browser)', percentile(prop, 95) <= 250, `p50 ${r1(percentile(prop, 50))} ms · p95 ${r1(percentile(prop, 95))} ms · max ${r1(prop[prop.length - 1] ?? 0)} ms (${prop.length} deliveries, ${Date.now() - t} ms burst)`);

    // ── 3. injected drift: knock three viewers off, measure recovery
    await api(pages[0], 'seek', 3);
    await sleep(3000);
    await clear(pages);
    const victims = [[1, 2.0], [2, -1.2], [3, 0.3]] as const;
    const injectAt = Date.now();
    await Promise.all(victims.map(([i, d]) => pages[i].evaluate((dd) => { const v = document.querySelector('video')!; v.currentTime = Math.max(0, v.currentTime + dd); }, d)));
    await sleep(4000);
    for (const [i, d] of victims) {
      const s = (await samples(pages[i])).filter((x) => x.t >= injectAt);
      // first sample after which drift stays within 500 ms
      let ok = s.length - 1;
      while (ok > 0 && Math.abs(s[ok - 1].drift) <= 0.5) ok--;
      const recovered = Math.abs(s[ok]?.drift ?? 9) <= 0.5 ? s[ok].t - injectAt : Infinity;
      const after = s.filter((x) => x.t >= injectAt + 1500).map((x) => x.drift);
      check(`recover from ${d > 0 ? '+' : ''}${d} s drift`, Number.isFinite(recovered) && stat(after).max <= 500, `back within 500 ms after ${Math.round(recovered)} ms · modes used: ${[...new Set(s.map((x) => x.mode))].join(',')} · max drift after 1.5 s ${stat(after).max} ms`);
    }

    // ── 4. seek storm from many viewers at once, then convergence
    for (let round = 0; round < 6; round++) {
      await Promise.all(pages.slice(0, 6).map((p, i) => api(p, 'seek', 2 + ((round * 7 + i * 3) % 18))));
      await sleep(250);
    }
    await sleep(3500);
    const seqs = await Promise.all(pages.map((p) => api<number>(p, 'seq')));
    check('seek storm: all viewers converge on the same state', new Set(seqs).size === 1, `${new Set(seqs).size} distinct seq across ${pages.length} pages (seq ${seqs[0]})`);
    await clear(pages);
    await sleep(3000);
    const afterStorm = stat((await Promise.all(pages.map(samples))).flat().filter((s) => !s.paused).map((s) => s.drift));
    check('drift ≤ 500 ms after seek storm', afterStorm.max <= 500, `p95 ${afterStorm.p95} ms · max ${afterStorm.max} ms`);

    // ── 5. pause → every video actually pauses
    await api(pages[0], 'pause');
    await sleep(700);
    const paused = await Promise.all(pages.map((p) => p.evaluate(() => document.querySelector('video')!.paused)));
    check('pause stops every player', paused.every(Boolean), `${paused.filter(Boolean).length}/${pages.length} paused within 700 ms`);
    await api(pages[0], 'seek', 6);
    await api(pages[0], 'play');
    await sleep(1500);

    // ── 6. late join while playing
    const lateStart = Date.now();
    const late = await open(PAGES);
    await late.waitForFunction(() => { const w = (window as any).__wp; return w && !w.paused && Math.abs(w.drift) <= 0.5 && w.exp > 1; }, null, { timeout: 15000 });
    const lateMs = Date.now() - lateStart;
    await sleep(2500);
    const ls = (await samples(late)).filter((s) => s.t > lateStart + 1500 + 0);
    const lateStat = stat(ls.filter((s) => !s.paused).map((s) => s.drift));
    check('late joiner lands in sync', lateStat.max <= 600, `playing within ${lateMs} ms of opening the page · drift p95 ${lateStat.p95} ms`);

    // ── 7. reconnect after a dropped socket
    const victim = pages[4];
    const idBefore = await api<string>(victim, 'youId');
    await api(victim, 'kill');
    await sleep(300);
    await api(pages[0], 'seek', 8); // room moves on while the victim is offline
    await victim.waitForFunction(() => (window as any).__wpApi.status() === 'live', null, { timeout: 15000 });
    const idAfter = await api<string>(victim, 'youId');
    await sleep(2500);
    const vs = await victim.evaluate(() => (window as any).__wp);
    check('reconnect keeps identity and resyncs', idBefore === idAfter && Math.abs(vs.drift) <= 0.5, `same seat: ${idBefore === idAfter} · drift after rejoin ${r1(vs.drift * 1000)} ms`);

    // ── report
    const env = { chrome: browser.version(), cpu: `${os.cpus()[0].model} ×${os.cpus().length}`, platform: `${os.platform()} ${os.release()}`, pages: PAGES + 1, clip: 'Sintel trailer 480p (4.4 MB) served locally' };
    const outDir = path.join(root, 'docs/results');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({ env, checks }, null, 2));
    console.log(`\nSaved ${path.relative(root, file)}`);
    const failed = checks.filter((c) => !c.ok);
    console.log(failed.length ? `\n${failed.length} check(s) failed` : `\nAll ${checks.length} checks passed`);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

await main().catch((e) => { console.error(e); process.exitCode = 1; });
process.exit(process.exitCode ?? 0);
