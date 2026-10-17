import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { UploadError, UploadStore } from '../src/uploads';
import { isoDuration } from '../src/youtube';

const dirs: string[] = [];
function store(over: Partial<ConstructorParameters<typeof UploadStore>[0]> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-up-'));
  dirs.push(dir);
  return new UploadStore({ dir, maxFileBytes: 1000, maxTotalBytes: 5000, ttlMs: 60_000, ffmpeg: null, ffprobe: null, ...over });
}
const body = (bytes: number) => Object.assign(Readable.from([Buffer.alloc(bytes, 1)]), { headers: { 'content-length': String(bytes) } }) as unknown as IncomingMessage;
const settle = () => new Promise((r) => setTimeout(r, 20));
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('UploadStore (no ffmpeg)', () => {
  it('stores a browser-ready file and marks it ready', async () => {
    const s = store();
    const seen: string[] = [];
    s.onChange = (u) => seen.push(u.status);
    const u = await s.receive(body(400), { room: 'ABCD23', by: 'm1', name: 'Holiday.mp4' });
    await settle();
    expect(s.get(u.id)).toMatchObject({ status: 'ready', size: 400, name: 'Holiday.mp4' });
    expect(fs.statSync(s.file(u.id)!).size).toBe(400);
    expect(seen).toContain('processing');
    expect(s.forRoom('ABCD23')).toHaveLength(1);
    expect(s.forRoom('OTHER2')).toHaveLength(0);
  });
  it('refuses files it can’t serve, oversize files and non-videos', async () => {
    const s = store();
    await expect(s.receive(body(10), { room: 'R', by: 'm', name: 'film.mkv' })).rejects.toThrow(/only take .mp4/);
    await expect(s.receive(body(10), { room: 'R', by: 'm', name: 'notes.pdf' })).rejects.toThrow(UploadError);
    await expect(s.receive(body(2000), { room: 'R', by: 'm', name: 'big.mp4' })).rejects.toThrow(/too big/);
  });
  it('deletes uploads after their time is up', async () => {
    const s = store();
    const u = await s.receive(body(10), { room: 'R', by: 'm', name: 'a.webm' });
    await settle();
    const file = s.file(u.id)!;
    s.sweep(false, Date.now() + 61_000);
    expect(s.get(u.id)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });
  it('only ever deletes its own files from the folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-up-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'keep-me.txt'), 'x');
    fs.writeFileSync(path.join(dir, '0123456789abcdef.mp4'), 'x');
    new UploadStore({ dir, maxFileBytes: 1, maxTotalBytes: 1, ttlMs: 1, ffmpeg: null, ffprobe: null });
    expect(fs.readdirSync(dir)).toEqual(['keep-me.txt']);
  });
});

describe('isoDuration', () => {
  it('reads YouTube durations', () => {
    expect(isoDuration('PT4M13S')).toBe(253);
    expect(isoDuration('PT1H2M')).toBe(3720);
    expect(isoDuration('P1DT1S')).toBe(86401);
    expect(isoDuration('P0D')).toBe(0);
  });
});

describe('YouTube search keys', () => {
  it('falls through to the next key when one runs out of quota, and remembers it', async () => {
    const { searchYouTube, resetYouTubeKeys } = await import('../src/youtube');
    resetYouTubeKeys();
    const used: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      const key = new URL(url).searchParams.get('key')!;
      used.push(key);
      if (key === 'A') return new Response(JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } }), { status: 403 });
      if (url.includes('/search?')) return new Response(JSON.stringify({ items: [{ id: { videoId: 'dQw4w9WgXcQ' }, snippet: { title: 'Rock &amp; roll', channelTitle: 'Ch' } }] }));
      return new Response(JSON.stringify({ items: [{ id: 'dQw4w9WgXcQ', contentDetails: { duration: 'PT3M33S' } }] }));
    }) as typeof fetch;
    try {
      const out = await searchYouTube('first', '1.1.1.1', 'A, B');
      expect(out[0]).toMatchObject({ id: 'dQw4w9WgXcQ', title: 'Rock & roll', duration: 213 });
      expect(used).toEqual(['A', 'B', 'B']); // A tried once, then benched for the details call
      used.length = 0;
      await searchYouTube('second', '1.1.1.1', 'A,B');
      expect(used).toEqual(['B', 'B']);
      await expect(searchYouTube('third', '1.1.1.1', 'A')).rejects.toMatchObject({ code: 'quota' });
    } finally {
      globalThis.fetch = real;
      resetYouTubeKeys();
    }
  });
});
