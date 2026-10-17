import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { normalizeRoomCode, type ClientMsg } from '../../shared/src/protocol';
import { isValidSourceId } from '../../shared/src/source';
import { parseCues, toVtt } from '../../shared/src/subtitles';
import { Room, RoomManager, setUploadLookup, type Conn } from './rooms';
import { UploadError, UploadStore, which } from './uploads';
import { searchYouTube, YouTubeSearchError } from './youtube';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');
const MEDIA_DIR = path.resolve(__dirname, '../media');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(__dirname, '../../.uploads');
const GB = 1024 ** 3;

export interface AppHandle {
  server: http.Server;
  manager: RoomManager;
  port: number;
  close(): Promise<void>;
}

export async function createApp(port = Number(process.env.PORT) || 4000, host = '0.0.0.0'): Promise<AppHandle> {
  const app = express();
  const manager = new RoomManager();
  manager.start();
  const uploads = new UploadStore({
    dir: UPLOAD_DIR,
    maxFileBytes: Number(process.env.UPLOAD_MAX_GB || 4) * GB,
    maxTotalBytes: Number(process.env.UPLOAD_TOTAL_GB || 12) * GB,
    ttlMs: 24 * 3600 * 1000,
    ffmpeg: which('ffmpeg'),
    ffprobe: which('ffprobe'),
  });
  uploads.onChange = (u, code) => manager.get(code)?.noteUpload(u);
  uploads.start();
  setUploadLookup((id) => uploads.get(id));

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // Caddy in front: req.ip is the viewer's address
  app.use(express.json({ limit: '2kb' }));
  // allow a separately hosted client (e.g. Netlify) to call the API; lock down with
  // ALLOWED_ORIGIN, a comma-separated list of origins
  const allowed = (process.env.ALLOWED_ORIGIN || '*').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    const ok = allowed.includes('*') ? '*' : origin && allowed.includes(origin) ? origin : allowed[0];
    res.setHeader('Access-Control-Allow-Origin', ok);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Room, X-Seat, X-Filename, X-Video');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.post('/api/rooms', (_req, res) => {
    const room = manager.create();
    res.json({ code: room.code });
  });
  app.get('/api/rooms/:code', (req, res) => {
    const room = manager.get(normalizeRoomCode(req.params.code));
    if (!room) return res.status(404).json({ error: 'not_found' });
    res.json({ code: room.code, viewers: room.connectedCount });
  });
  /** the room member making an HTTP request, proven by their room code + seat token */
  const member = (req: express.Request) => {
    const room = manager.get(normalizeRoomCode(String(req.headers['x-room'] ?? '')));
    const rec = room?.memberByToken(String(req.headers['x-seat'] ?? ''));
    return room && rec ? { room, rec } : null;
  };
  const fileName = (req: express.Request) => { try { return decodeURIComponent(String(req.headers['x-filename'] ?? '')); } catch { return ''; } };

  // ── uploads: raw file body in, ffmpeg-checked MP4/WebM out
  app.post('/api/uploads', async (req, res) => {
    const who = member(req);
    if (!who) return res.status(403).json({ error: 'Join the room before uploading.' });
    try {
      res.json(await uploads.receive(req, { room: who.room.code, by: who.rec.id, name: fileName(req) }));
    } catch (e) {
      const status = e instanceof UploadError ? e.status : 500;
      if (!res.headersSent) res.status(status).set('Connection', 'close').json({ error: e instanceof UploadError ? e.message : 'The upload failed.' });
    }
  });
  app.get('/api/uploads/:id', (req, res) => {
    const u = uploads.get(req.params.id);
    return u ? res.json(u) : res.status(404).json({ error: 'not_found' });
  });
  app.get('/uploads/:id', (req, res) => {
    const f = uploads.file(req.params.id);
    if (!f) return res.status(404).end();
    res.sendFile(f, { acceptRanges: true, dotfiles: 'allow', maxAge: '1h', headers: { 'Access-Control-Allow-Origin': '*' } });
  });

  // ── subtitles: .srt/.vtt text in, WebVTT shared with the room
  app.post('/api/subtitles', express.text({ type: () => true, limit: '3mb' }), (req, res) => {
    const who = member(req);
    if (!who) return res.status(403).json({ error: 'Join the room before adding subtitles.' });
    const videoId = String(req.headers['x-video'] ?? '');
    if (!isValidSourceId(videoId)) return res.status(400).json({ error: 'Pick something to watch first.' });
    const cues = parseCues(typeof req.body === 'string' ? req.body : '');
    if (!cues.length) return res.status(400).json({ error: 'No subtitles found in that file. Use a .srt or .vtt file.' });
    const label = fileName(req).replace(/\.(srt|vtt|txt)$/i, '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || 'Subtitles';
    res.json(who.room.setSubs(videoId, who.rec, label, toVtt(cues), cues.length));
  });
  app.get('/api/subtitles/:file', (req, res) => {
    const id = req.params.file.replace(/\.vtt$/, '');
    for (const room of manager.rooms.values()) {
      const vtt = room.subsVtt(id);
      if (vtt) return res.type('text/vtt').set('Cache-Control', 'private, max-age=3600').send(vtt);
    }
    res.status(404).end();
  });

  // ── YouTube search (the API key never leaves the server)
  app.get('/api/youtube/search', async (req, res) => {
    try {
      res.json({ items: await searchYouTube(String(req.query.q ?? ''), req.ip ?? '') });
    } catch (e) {
      const err = e instanceof YouTubeSearchError ? e : new YouTubeSearchError(502, 'YouTube search failed. Paste a link instead.');
      res.status(err.status).json({ error: err.message, code: err.code });
    }
  });

  // WebRTC relay servers. With TURN_SECRET set (coturn `use-auth-secret`), hand out
  // credentials that expire in 12 h, so the TURN server can't be used as an open relay.
  app.get('/api/ice', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ iceServers: iceServers() });
  });
  app.get('/api/health', (_req, res) => {
    let members = 0;
    let controls = 0;
    let dropped = 0;
    for (const r of manager.rooms.values()) { members += r.connectedCount; controls += r.stats.controls; dropped += r.stats.dropped; }
    res.json({ ok: true, rooms: manager.rooms.size, members, controls, dropped, uptime: process.uptime(), mem: process.memoryUsage().rss });
  });
  // optional local media for offline LAN screenings
  if (fs.existsSync(MEDIA_DIR)) app.use('/media', express.static(MEDIA_DIR, { acceptRanges: true }));

  if (fs.existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST, { maxAge: '1h', index: false }));
    app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
  } else {
    app.get('/', (_req, res) => res.type('text').send('Watch Party server is running. Start the client with `npm run dev` or build it with `npm run build`.'));
  }

  const server = http.createServer(app);
  server.requestTimeout = 0; // big uploads on slow connections can take a while
  server.headersTimeout = 60_000;
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024, perMessageDeflate: false });

  wss.on('connection', (ws: WebSocket) => {
    let room: Room | null = null;
    let memberId: string | null = null;
    let alive = true;
    const conn: Conn = {
      send(raw) {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > 2 * 1024 * 1024) return ws.terminate(); // hopelessly slow consumer
        ws.send(raw);
      },
      close(code, reason) { ws.close(code, reason); },
    };
    const joinTimer = setTimeout(() => { if (!room) ws.close(4001, 'join timeout'); }, 5000);

    ws.on('pong', () => { alive = true; });
    const hb = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 10000);

    ws.on('message', (data) => {
      alive = true;
      let msg: ClientMsg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof (msg as any).t !== 'string') return;
      if (!room) {
        if (msg.t !== 'join') return;
        const code = normalizeRoomCode(String(msg.code ?? ''));
        const r = manager.get(code);
        if (!r) {
          conn.send(JSON.stringify({ t: 'error', code: 'no_room', message: `Room ${code || '—'} isn’t open. Check the code or start a new room.`, fatal: true }));
          return ws.close(4004, 'no room');
        }
        const rec = r.join(conn, msg);
        if (rec) { room = r; memberId = rec.id; clearTimeout(joinTimer); }
        return;
      }
      const rec = room.members.get(memberId!);
      if (rec && rec.conn === conn) room.handle(rec, msg);
    });

    ws.on('close', () => {
      clearTimeout(joinTimer);
      clearInterval(hb);
      if (room && memberId) room.disconnect(memberId, conn);
    });
    ws.on('error', () => ws.terminate());
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const actual = (server.address() as { port: number }).port;
  return {
    server,
    manager,
    port: actual,
    async close() {
      manager.stop();
      uploads.stop();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export function iceServers(env = process.env, now = Date.now()): RTCIceServerLike[] {
  const host = env.TURN_HOST;
  const secret = env.TURN_SECRET;
  if (!host) return [{ urls: 'stun:stun.l.google.com:19302' }];
  const out: RTCIceServerLike[] = [{ urls: `stun:${host}:3478` }];
  if (secret) {
    const username = `${Math.floor(now / 1000) + 12 * 3600}:watchparty`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    const urls = [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`];
    if (env.TURN_TLS === '1') urls.push(`turns:${host}:5349?transport=tcp`);
    out.push({ urls, username, credential });
  }
  return out;
}
interface RTCIceServerLike { urls: string | string[]; username?: string; credential?: string }

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { port } = await createApp();
  console.log(`\n  Watch Party server on :${port}`);
  console.log(`  Local   http://localhost:${port}`);
  for (const ip of lanAddresses()) console.log(`  Network http://${ip}:${port}`);
  console.log('');
}
