// Videos people upload into a room. Files land on the server's disk, get checked with
// ffprobe, and are remuxed or converted to H.264/AAC MP4 with ffmpeg when a browser
// couldn't play them as they are. Everything is deleted a day after upload.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';

export type UploadStatus = 'uploading' | 'processing' | 'ready' | 'failed';

export interface UploadInfo {
  id: string;
  name: string;
  size: number;
  status: UploadStatus;
  /** 0–1 while uploading or converting */
  progress: number;
  error?: string;
  /** seconds, once known */
  duration?: number;
  createdAt: number;
  by: string;
}

interface UploadRec extends UploadInfo {
  room: string;
  /** final file on disk, once ready */
  file?: string;
}

export interface UploadOptions {
  dir: string;
  maxFileBytes: number;
  maxTotalBytes: number;
  ttlMs: number;
  /** null = ffmpeg isn't installed: accept browser-ready files as they are */
  ffmpeg: string | null;
  ffprobe: string | null;
}

const PLAYABLE_EXT = /\.(mp4|m4v|webm)$/i;
const OWN_FILE = /^[a-f0-9]{16}(\.src)?\.[a-z0-9]{2,5}$/;
const VIDEO_EXT = /\.(mp4|m4v|webm|mkv|mov|avi|wmv|flv|mpg|mpeg|ts|m2ts|3gp|ogv)$/i;

export class UploadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** first executable found on PATH, or null */
export function which(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}

function run(bin: string, args: string[], onLine?: (l: string) => void): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let buf = '';
    p.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      out += s.length < 1e6 ? s : '';
      if (onLine) { buf += s; const lines = buf.split('\n'); buf = lines.pop()!; lines.forEach(onLine); }
    });
    p.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-4000); });
    p.on('close', (code) => resolve({ code: code ?? 1, out, err }));
    p.on('error', (e) => resolve({ code: 1, out, err: String(e) }));
  });
}

export class UploadStore {
  private recs = new Map<string, UploadRec>();
  private queue: (() => Promise<void>)[] = [];
  private converting = false;
  private timer: NodeJS.Timeout | null = null;
  /** told whenever an upload changes state, so rooms can update their viewers */
  onChange: (u: UploadInfo, room: string) => void = () => {};

  constructor(readonly opts: UploadOptions) {
    fs.mkdirSync(opts.dir, { recursive: true });
    // files from before a restart are orphans (their rooms are gone): clear out ours, and only ours
    for (const f of fs.readdirSync(opts.dir)) if (OWN_FILE.test(f)) fs.rmSync(path.join(opts.dir, f), { force: true });
  }

  start() {
    this.timer = setInterval(() => this.sweep(), 10 * 60 * 1000);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  get(id: string): UploadInfo | undefined {
    const r = this.recs.get(id);
    return r && this.info(r);
  }
  /** absolute path of a ready upload's file */
  file(id: string): string | undefined {
    const r = this.recs.get(id);
    return r?.status === 'ready' ? r.file : undefined;
  }
  forRoom(room: string): UploadInfo[] {
    return [...this.recs.values()].filter((r) => r.room === room).sort((a, b) => b.createdAt - a.createdAt).map((r) => this.info(r));
  }
  private info(r: UploadRec): UploadInfo {
    const { room: _room, file: _file, ...pub } = r;
    return pub;
  }
  private bytesOnDisk() {
    let n = 0;
    for (const f of fs.readdirSync(this.opts.dir)) { if (!OWN_FILE.test(f)) continue; try { n += fs.statSync(path.join(this.opts.dir, f)).size; } catch { /* racing a delete */ } }
    return n;
  }
  private changed(r: UploadRec) { this.onChange(this.info(r), r.room); }

  /** stream a request body to disk, then queue it for checking/conversion */
  async receive(req: IncomingMessage, opts: { room: string; by: string; name: string; now?: number }): Promise<UploadInfo> {
    const name = opts.name.replace(/[\\/\u0000-\u001f]/g, '').trim().slice(0, 140) || 'video';
    if (!VIDEO_EXT.test(name)) throw new UploadError(415, 'That doesn’t look like a video file. Try .mp4, .mkv, .mov, .webm or .avi.');
    if (!this.opts.ffmpeg && !PLAYABLE_EXT.test(name)) throw new UploadError(415, 'This server can only take .mp4 and .webm files right now.');
    const declared = Number(req.headers['content-length'] ?? NaN);
    if (Number.isFinite(declared) && declared > this.opts.maxFileBytes) throw new UploadError(413, `That file is too big. The limit is ${Math.round(this.opts.maxFileBytes / 1e9)} GB.`);
    if (this.bytesOnDisk() + (Number.isFinite(declared) ? declared : 0) > this.opts.maxTotalBytes) {
      this.sweep(true);
      if (this.bytesOnDisk() + (Number.isFinite(declared) ? declared : 0) > this.opts.maxTotalBytes) throw new UploadError(507, 'The server is out of space for uploads right now. Try again later.');
    }
    if ([...this.recs.values()].filter((r) => r.room === opts.room && (r.status === 'uploading' || r.status === 'processing')).length >= 2) {
      throw new UploadError(429, 'Two uploads are already in progress in this room. Wait for one to finish.');
    }

    const id = randomBytes(8).toString('hex');
    const raw = path.join(this.opts.dir, `${id}.src${path.extname(name).toLowerCase()}`);
    const rec: UploadRec = { id, name, size: 0, status: 'uploading', progress: 0, createdAt: opts.now ?? Date.now(), by: opts.by, room: opts.room };
    this.recs.set(id, rec);
    this.changed(rec);

    try {
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(raw);
        let lastNote = 0;
        req.on('data', (chunk: Buffer) => {
          rec.size += chunk.length;
          if (rec.size > this.opts.maxFileBytes) { req.destroy(); out.destroy(); reject(new UploadError(413, `That file is too big. The limit is ${Math.round(this.opts.maxFileBytes / 1e9)} GB.`)); return; }
          if (Number.isFinite(declared) && declared > 0) rec.progress = rec.size / declared;
          if (Date.now() - lastNote > 1000) { lastNote = Date.now(); this.changed(rec); }
        });
        req.on('aborted', () => reject(new UploadError(400, 'The upload was interrupted.')));
        req.on('error', reject);
        out.on('error', reject);
        req.pipe(out);
        out.on('finish', () => resolve());
      });
    } catch (e) {
      fs.rmSync(raw, { force: true });
      this.recs.delete(id);
      throw e instanceof UploadError ? e : new UploadError(400, 'The upload was interrupted.');
    }
    if (rec.size === 0) {
      fs.rmSync(raw, { force: true });
      this.recs.delete(id);
      throw new UploadError(400, 'That file is empty.');
    }

    rec.status = 'processing';
    rec.progress = 0;
    this.changed(rec);
    this.enqueue(() => this.process(rec, raw));
    return this.info(rec);
  }

  private enqueue(job: () => Promise<void>) {
    this.queue.push(job);
    if (!this.converting) void this.drain();
  }
  private async drain() {
    this.converting = true;
    while (this.queue.length) {
      const job = this.queue.shift()!;
      try { await job(); } catch (e) { console.error('[uploads] job failed', e); }
    }
    this.converting = false;
  }

  private fail(rec: UploadRec, raw: string, error: string) {
    fs.rmSync(raw, { force: true });
    rec.status = 'failed';
    rec.error = error;
    this.changed(rec);
  }

  /** decide whether the file can be served as is, remuxed, or must be converted */
  private async process(rec: UploadRec, raw: string) {
    if (!this.recs.has(rec.id)) return fs.rmSync(raw, { force: true });
    const { ffmpeg, ffprobe } = this.opts;
    if (!ffmpeg || !ffprobe) {
      rec.file = raw;
      rec.status = 'ready';
      rec.progress = 1;
      return this.changed(rec);
    }
    const probe = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name', '-of', 'json', raw]);
    let info: { format?: { duration?: string; format_name?: string }; streams?: { codec_type: string; codec_name: string }[] };
    try { info = JSON.parse(probe.out); } catch { info = {}; }
    const video = info.streams?.find((s) => s.codec_type === 'video');
    const audio = info.streams?.find((s) => s.codec_type === 'audio');
    if (probe.code !== 0 || !video) return this.fail(rec, raw, 'That file has no video we can read.');
    const duration = Number(info.format?.duration);
    if (Number.isFinite(duration) && duration > 0) rec.duration = duration;
    const fmt = info.format?.format_name ?? '';

    const webmOk = /webm|matroska/.test(fmt) && /\.webm$/i.test(raw) && ['vp8', 'vp9', 'av1'].includes(video.codec_name) && (!audio || ['opus', 'vorbis'].includes(audio.codec_name));
    const h264 = video.codec_name === 'h264';
    const audioOk = !audio || ['aac', 'mp3'].includes(audio.codec_name);
    const out = path.join(this.opts.dir, `${rec.id}${webmOk ? '.webm' : '.mp4'}`);

    let args: string[] | null;
    if (webmOk) args = null; // serve as is
    else if (h264 && audioOk) args = ['-c', 'copy']; // already browser-ready: just move the index to the front
    else args = [
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-vf', "scale='min(1280,iw)':-2", '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    ];

    if (args === null) {
      fs.renameSync(raw, out);
    } else {
      const total = rec.duration ?? 0;
      const res = await run('nice', ['-n', '10', ffmpeg, '-hide_banner', '-nostdin', '-y', '-i', raw, '-map', '0:v:0', '-map', '0:a:0?', ...args, '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out], (line) => {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && total > 0) {
          const p = Math.min(0.99, Number(m[1]) / 1e6 / total);
          if (p - rec.progress >= 0.01) { rec.progress = p; this.changed(rec); }
        }
      });
      fs.rmSync(raw, { force: true });
      if (res.code !== 0) {
        fs.rmSync(out, { force: true });
        console.error('[uploads] ffmpeg failed', res.err.slice(-800));
        return this.fail(rec, raw, 'We couldn’t convert that video. Try exporting it as an MP4.');
      }
    }
    if (!this.recs.has(rec.id)) { fs.rmSync(out, { force: true }); return; } // expired while converting
    rec.file = out;
    rec.status = 'ready';
    rec.progress = 1;
    this.changed(rec);
  }

  /** delete uploads past their TTL (or, under disk pressure, the oldest finished ones) */
  sweep(pressure = false, now = Date.now()) {
    const done = [...this.recs.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const r of done) {
      const expired = now - r.createdAt > this.opts.ttlMs;
      if (!expired && !(pressure && r.status !== 'uploading' && r.status !== 'processing')) continue;
      if (r.file) fs.rmSync(r.file, { force: true });
      this.recs.delete(r.id);
      if (pressure && this.bytesOnDisk() < this.opts.maxTotalBytes * 0.7) break;
    }
  }
}
