// Real-browser check of everything that isn't a catalog film: pasted file links, webcams,
// microphones and screen sharing between two Chrome pages in one room.
//
//   npm run build && npm run e2e:av            # add --headed to watch
//   E2E_BASE=https://your.site npm run e2e:av   # check a deployed server instead of a local one
//   E2E_API=https://server E2E_BASE=https://client.netlify.app npm run e2e:av   # client and server apart
//
// Chrome's fake devices stand in for the camera, mic and screen picker, so nothing prompts.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADED = process.argv.includes('--headed');
const PORT = 4900 + Math.floor(Math.random() * 90);
const REMOTE = process.env.E2E_BASE?.replace(/\/+$/, '');
const BASE = REMOTE ?? `http://127.0.0.1:${PORT}`;
const API = process.env.E2E_API?.replace(/\/+$/, '') ?? BASE;
// a deployed server doesn't carry the local test clip; use a public file instead
const LINK = REMOTE ? 'https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4' : null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** poll a page until `fn` is truthy (or time out and return the last value) */
async function until<T>(p: Page, fn: string, ms = 15000): Promise<T> {
  const t0 = Date.now();
  let v: T = undefined as T;
  while (Date.now() - t0 < ms) {
    v = await p.evaluate(fn) as T;
    if (v) return v;
    await sleep(200);
  }
  return v;
}

async function main() {
  if (!REMOTE && !fs.existsSync(path.join(root, 'client/dist/index.html'))) throw new Error('Build the client first: npm run build');
  const server: ChildProcess | null = REMOTE ? null : spawn('npx', ['tsx', 'server/src/index.ts'], { cwd: root, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'inherit'] });
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: !HEADED,
    args: [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-accept-this-tab-capture',
      '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    ],
  });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`${API}/api/health`)).ok) break; } catch { /* starting */ } await sleep(250); }
    const code = ((await (await fetch(`${API}/api/rooms`, { method: 'POST' })).json()) as { code: string }).code;
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, permissions: ['camera', 'microphone'] });
    const open = async (name: string) => {
      const p = await ctx.newPage();
      p.on('pageerror', (e) => console.log(`  [${name}] page error: ${e.message}`));
      await p.addInitScript((n) => sessionStorage.setItem('wp:profile', JSON.stringify({ name: n, color: '#4EE6B5' })), name);
      await p.goto(`${BASE}/r/${code}`);
      await p.waitForFunction(() => (window as any).__wpApi?.status() === 'live', null, { timeout: 15000 });
      return p;
    };
    const a = await open('Asha');
    const b = await open('Ben');

    // ── a pasted file link plays in sync on both pages
    await a.evaluate((link) => (window as any).__wpApi.load('url:' + (link ?? location.origin + '/media/test-clip.mp4')), LINK);
    await until(b, `window.__wp?.state?.videoId?.startsWith('url:')`);
    await until(a, `window.__wp?.kind && document.querySelector('video.stage__video')?.readyState >= 3`, 30000);
    await until(b, `document.querySelector('video.stage__video')?.readyState >= 3`, 30000);
    await a.evaluate(() => (window as any).__wpApi.play());
    await sleep(REMOTE ? 8000 : 4000);
    const drift = await Promise.all([a, b].map((p) => p.evaluate(() => (window as any).__wp)));
    check('file link plays on both pages', drift.every((d) => !d.paused && d.pos > 1), drift.map((d) => `pos ${d.pos.toFixed(2)}`).join(', '));
    check('file link stays in sync', drift.every((d) => Math.abs(d.drift) < 0.5), drift.map((d) => `${Math.round(d.drift * 1000)} ms`).join(', '));
    const meta = await b.evaluate(() => Object.values((window as any).__wpStore().meta as Record<string, { duration?: number }>)[0]?.duration);
    check('server learned the link’s duration', !!meta && meta > 1, `${meta} s`);

    // ── Asha turns on camera + mic → Ben sees her face on her seat and gets her audio
    await a.getByRole('button', { name: 'Camera' }).click();
    await a.getByRole('button', { name: 'Mic' }).click();
    const camOnB = await until<number>(b, `(() => { const v = document.querySelector('.seat:not(.is-you) .seat__cam'); return v && v.videoWidth; })()`);
    check('Ben sees Asha’s camera on her seat', !!camOnB, `${camOnB}px wide`);
    const audioOnB = await until<boolean>(b, `(() => { const v = document.querySelector('.seat:not(.is-you) .seat__cam'); return !!v?.srcObject?.getAudioTracks().length; })()`);
    check('Ben receives Asha’s microphone', audioOnB);
    const selfCam = await until<number>(a, `document.querySelector('.seat.is-you .seat__cam')?.videoWidth`);
    check('Asha sees her own preview', !!selfCam);

    // ── Ben turns his camera on too (both directions over one connection)
    await b.getByRole('button', { name: 'Camera' }).click();
    const camOnA = await until<number>(a, `(() => { const v = document.querySelector('.seat:not(.is-you) .seat__cam'); return v && v.videoWidth; })()`);
    check('Asha sees Ben’s camera', !!camOnA);

    // ── Ben shares his screen → it replaces the film on Asha's stage, film pauses
    await b.getByRole('button', { name: 'Share screen' }).click();
    const screenOnA = await until<number>(a, `document.querySelector('.screen__video')?.videoWidth`, 20000);
    check('Asha sees Ben’s screen on the stage', !!screenOnA, `${screenOnA}px wide`);
    const paused = await a.evaluate(() => (window as any).__wp.paused);
    check('the film paused under the screen share', paused);

    // ── Ben stops; the stage returns to the film
    await b.getByRole('button', { name: 'Stop sharing' }).first().click();
    const gone = await until<boolean>(a, `!document.querySelector('.screen')`);
    check('stopping the share clears the stage', gone);

    // ── Asha's camera off → Ben's view of her seat falls back to her avatar
    await a.getByRole('button', { name: 'Camera' }).click();
    const off = await until<boolean>(b, `!document.querySelector('.seat:not(.is-you).has-cam')`);
    check('camera off returns the seat to an avatar', off);

    // ── Ben reloads mid-call → connection rebuilds and he sees Asha's camera again
    await a.getByRole('button', { name: 'Camera' }).click();
    await b.reload();
    await b.waitForFunction(() => (window as any).__wpApi?.status() === 'live', null, { timeout: 15000 });
    const again = await until<number>(b, `(() => { const v = document.querySelector('.seat:not(.is-you) .seat__cam'); return v && v.videoWidth; })()`, 20000);
    check('after a reload Ben gets Asha’s camera again', !!again);

    // ── Asha uploads a video through the Upload tab; Ben sees it, both play it in sync
    await a.getByRole('button', { name: 'Find a movie' }).first().click();
    await a.getByRole('tab', { name: 'Upload a video' }).click();
    // E2E_UPLOAD=some.mkv exercises the server's ffmpeg conversion (needs ffmpeg where the server runs)
    await a.locator('.drop input[type=file]').setInputFiles(process.env.E2E_UPLOAD || path.join(root, 'server/media/test-clip.mp4'));
    const t0 = Date.now();
    const readyRow = await until<boolean>(b, `(window.__wpStore().uploads || []).some((u) => u.status === 'ready')`, 180000);
    if (process.env.E2E_UPLOAD) console.log(`  upload + conversion took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    check('upload finishes and reaches everyone', readyRow);
    await until(a, `!!document.querySelector('.uprow--ready')`, 10000);
    await a.locator('.uprow--ready').getByRole('button', { name: 'Play now' }).click();
    await until(b, `window.__wp?.state?.videoId?.startsWith('up:')`);
    await until(b, `document.querySelector('video.stage__video')?.readyState >= 3`, 30000);
    await a.evaluate(() => (window as any).__wpApi.play());
    await sleep(3000);
    const up = await Promise.all([a, b].map((p) => p.evaluate(() => ({ ...(window as any).__wp, src: (document.querySelector('video.stage__video') as HTMLVideoElement).currentSrc }))));
    check('uploaded video plays on both pages from our server', up.every((d) => !d.paused && d.pos > 1 && /\/uploads\//.test(d.src)), up.map((d) => `pos ${d.pos.toFixed(2)}`).join(', '));

    // ── Ben adds subtitles; Asha sees the caption
    const srt = path.join(os.tmpdir(), `wp-e2e-${Date.now()}.srt`);
    fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:10:00,000\nHello from the subtitles\n');
    await b.getByRole('button', { name: 'Subtitles' }).click({ force: true });
    await b.locator('.menu input[type=file]').setInputFiles(srt);
    const caption = await until<string>(a, `document.querySelector('.captions')?.textContent`, 10000);
    check('subtitles show for everyone in the room', caption === 'Hello from the subtitles', caption);
    fs.rmSync(srt, { force: true });

    // ── YouTube tab: search either works or says plainly that it isn't set up
    await a.getByRole('button', { name: 'Find a movie' }).first().click();
    await a.getByRole('tab', { name: 'YouTube' }).click();
    await a.getByRole('searchbox', { name: /Search YouTube/ }).fill('blender open movie');
    const yt = await until<string>(a, `document.querySelector('.ytcard:not(.is-ghost)') ? 'results' : (document.querySelector('.linkhelp, .empty--big')?.textContent && document.body.textContent.match(/isn’t set up|limit|failed/) ? 'explained' : '')`, 15000);
    check('YouTube search returns results or explains why not', yt === 'results' || yt === 'explained', yt);
    await a.keyboard.press('Escape');

    // ── host moderation: Asha (host) removes Ben; he can't come back from that seat
    await a.locator('.seat:not(.is-you) .seat__btn').first().click();
    await a.getByRole('menuitem', { name: 'Remove from room' }).click();
    await a.getByRole('menuitem', { name: /Yes, remove/ }).click();
    const kicked = await until<string>(b, `document.querySelector('.gate h1')?.textContent`);
    check('removed viewer is told why', /removed you/.test(kicked ?? ''), kicked);
    await b.reload();
    const stillOut = await until<string>(b, `document.querySelector('.gate h1')?.textContent`);
    check('removed viewer can’t rejoin by reloading', /removed you/.test(stillOut ?? ''));
    const seatsLeft = await until<number>(a, `document.querySelectorAll('.seat').length === 1 ? 1 : 0`) || await a.locator('.seat').count();
    check('their seat is gone for everyone', seatsLeft === 1, `${seatsLeft} seat(s)`);

    // ── lock: newcomers are turned away
    await a.getByRole('button', { name: 'Room settings' }).click();
    await a.getByRole('switch', { name: 'Lock the room' }).click();
    await until(a, `!!document.querySelector('.rhead__lock')`);
    const c = await ctx.newPage();
    await c.addInitScript(() => sessionStorage.setItem('wp:profile', JSON.stringify({ name: 'Cara', color: '#4EE6B5' })));
    await c.goto(`${BASE}/r/${code}`);
    const locked = await until<string>(c, `document.querySelector('.gate h1')?.textContent`);
    check('a locked room turns newcomers away', /locked/.test(locked ?? ''), locked);
  } finally {
    await browser.close();
    server?.kill('SIGTERM');
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
