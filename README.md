# Watch Party

Watch movies in lockstep with friends. One person starts a room, shares the link or a six-character code, and everyone's play, pause and seek stay in sync — with live chat, emoji reactions, a shared queue, group polls and host transfer riding along.

> **Same movie. Same second.**

All titles in the catalog are public-domain or Creative-Commons films (Blender open movies, silent-era classics, public-domain features), so there is nothing to license.

## Run it

Requires Node 20+.

```bash
npm install
npm start          # builds the client, then serves everything on http://localhost:4000
```

`npm start` prints a **Network** URL (e.g. `http://192.168.1.20:4000`). Open it on any device on the same Wi-Fi and everyone can join the same room.

For development with hot reload (client on `:5173`, proxying to the server on `:4000`):

```bash
npm run dev
```

## What's in it

| Requirement | Where it lives |
| --- | --- |
| Create / join via invite link or room code | Lobby ticket (`/`), `/r/KQTM72` links, **Invite** popover |
| Synced play, pause, seek | Server-authoritative playback anchor; `shared/src/sync.ts` |
| Discovery: categories, filters, fuzzy search | **Find a movie** drawer: recommendation rails, genre/mood/length/era filters, Fuse.js fuzzy search |
| Emoji reactions, live chat | Reaction bar (keys `1`–`7`), Chat tab with typing indicators |
| Shared playlist | Queue tab: add, up-vote to reorder, play now, remove, auto-advance |
| Group polls | Polls tab: live bars, change your vote, closing queues the winner |
| Host transfer | Click a seat → *Make host*, or Settings → People; automatic if the host disappears |
| Drift detection and correction | `client/src/net/syncEngine.ts` (nudge → seek), reported live to the room |
| Late joins, reconnects, concurrent actions | Snapshot-on-join, seat tokens + 30 s grace, serialized idempotent controls |

### Creative extras

- **Sync Strip**: the seek bar is a film strip. Every viewer is a pin on it (green / amber / red by drift), and reactions are stamped to the timecode so the room's best moments glow as a heat-map.
- **Seat row**: viewers sit in a row of cinema seats under the screen, each with a live drift gauge, buffering ring, host crown and typing dots. Reactions float up from the sender's seat.
- **Start together**: a ready check followed by a film-leader 3-2-1 that lands on the same server instant for everyone. The tap on "I'm ready" also unlocks audio autoplay on that device.
- **Hold for stragglers**: if someone's video is buffering, the room pauses, then resumes together (with a 15 s cap, and a grace period for people who just joined).
- **Sync health** popover: round trip, clock offset, your drift and correction mode, and the control latency this device has actually measured. The proof for the numbers below, in the product.

## How the sync works

The server owns one playback **anchor**: `{ videoId, status, anchorPos, anchorServerTime, seq }`. The playhead at any moment is `anchorPos + (serverNow − anchorServerTime)` while playing. Because the room is described by an anchor rather than a stream of positions, a late joiner or a reconnecting client needs exactly one message to be correct.

- **Clock sync**: each client runs NTP-style ping bursts and keeps the median offset of its five lowest-RTT samples, so it can evaluate the anchor on the server's clock.
- **Controls** are intents (`play`, `pause`, `seek`, `load`), not toggles, so two people pressing pause at once converge on one state. The server serializes them, stamps `seq`, and schedules `play` / seek-while-playing ~180 ms ahead so every client starts at the same instant.
- **Drift loop** (every 250 ms): under 50 ms leave it alone; under 400 ms nudge `playbackRate` by 3–12 % (no visible jump); beyond that hard-seek, with a 1.5 s cooldown so a struggling client can't seek-storm.
- **Failure handling**: heartbeats drop dead sockets, seat tokens survive reconnects (30 s grace), rate limits and payload caps protect the room, and stale `seq`s are ignored. See [docs/LATENCY.md](docs/LATENCY.md) for the full matrix.

## Test it

```bash
npm test                    # 37 unit tests: sync math, room state machine, concurrency, hold, polls…
npm run verify-catalog      # every catalog URL answers 206 with byte-range support
npm run loadtest            # 10 / 25 / 50 headless viewers + chaos; reports p50/p95/p99 propagation
npm run loadtest -- --users=10 --seconds=30 --netdelay=15 --jitter=10   # emulated network
npm run build && npm run e2e   # 10+ real Chrome pages with real <video>: drift, recovery, late join, reconnect
```

Measured results, test conditions and caveats are in **[docs/LATENCY.md](docs/LATENCY.md)**.

`npm run e2e` needs Google Chrome installed and a small local clip at `server/media/test-clip.mp4` (see the doc).

## Layout

```
shared/    protocol types, sync math, catalog            (used by server, client, tests, bots)
server/    Express + ws; src/rooms.ts is the room state machine
client/    Vite + React + TypeScript; src/net/ (socket, sync engine), src/components/, src/styles/
scripts/   loadtest.ts, e2e-drift.ts, verify-catalog.ts
docs/      LATENCY.md and raw JSON results
```

## Notes and limits

- Rooms live in server memory; restarting the server closes them. There are no accounts. A viewer is a name and a seat color.
- Video streams straight from archive.org, so playback needs internet. Drop your own files in `server/media/` to serve them from the LAN (they are available at `/media/<file>`).
- Browsers require a tap before playing with sound; if a device blocks autoplay the stage shows **Tap to join the screening**.
- Posters are generated typography, not artwork, so there are no image assets to license.
