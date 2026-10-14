import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { normalizeRoomCode, type ClientMsg } from '../../shared/src/protocol';
import { Room, RoomManager, type Conn } from './rooms';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');
const MEDIA_DIR = path.resolve(__dirname, '../media');

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

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2kb' }));

  app.post('/api/rooms', (_req, res) => {
    const room = manager.create();
    res.json({ code: room.code });
  });
  app.get('/api/rooms/:code', (req, res) => {
    const room = manager.get(normalizeRoomCode(req.params.code));
    if (!room) return res.status(404).json({ error: 'not_found' });
    res.json({ code: room.code, viewers: room.connectedCount });
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
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024, perMessageDeflate: false });

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
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

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
