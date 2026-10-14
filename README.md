<div align="center">

# 🍿 Watch Party

### Same movie. Same second.

Watch movies in lockstep with friends. Start a room, share the link, and everyone's play, pause and seek stay in sync, with live chat, reactions, a shared queue and group polls along for the ride.

**Built by [Dharoon Balajii](https://github.com/DharoonBalajii) for VinnovateIT Recruitment'26**

![Node](https://img.shields.io/badge/node-%E2%89%A5%2020.19-3c873a) ![React](https://img.shields.io/badge/React-19-61dafb) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6) ![p95 latency](https://img.shields.io/badge/control%20latency%20p95-3%20ms-ffd84a) ![drift](https://img.shields.io/badge/max%20drift-83%20ms-ff5c8a)

</div>

---

## Quick start

You need **Node 20.19+** (check with `node -v`) and a modern browser. Nothing else: no database, no accounts, no API keys.

```bash
git clone https://github.com/DharoonBalajii/Watch-Party-VinnovateIT.git
cd Watch-Party-VinnovateIT
npm install
npm start
```

Open **http://localhost:4000**, enter a name, press **Start a room**, and send the invite link to a friend.

`npm start` also prints a **Network** address such as `http://192.168.1.20:4000`. Anyone on the same Wi-Fi can open it and join your room.

| I want to… | Run |
| --- | --- |
| Use the app | `npm start` |
| Develop with hot reload (client on :5173) | `npm run dev` |
| Run the unit tests | `npm test` |
| Check that every movie URL works | `npm run verify-catalog` |
| Load-test the server | `npm run loadtest` |
| Test in real browsers | `npm run build && npm run e2e` |

> Videos stream from archive.org, so playback needs an internet connection. To serve your own files from the LAN instead, drop them in `server/media/` (they appear at `/media/<file>`).

## Features

**Rooms**
- Create and join through an invite link (`/r/KQTM72`) or a six-character code.
- Up to 50 viewers per room, with a clear message when it's full.
- Host controls, automatic host transfer if the host disappears, and a "host only" mode.

**Synced playback**
- Play, pause and seek reach everyone together, even when several people act at once.
- Automatic drift detection and correction, so nobody quietly falls behind.
- Late joiners land on the right frame; dropped connections rejoin their own seat.

**Discover**
- 21 public-domain and Creative-Commons films: Blender open movies, silent-era classics, and public-domain features.
- Recommendation rails ("More like this", "Quick watches", "Lights off"…).
- Filters by genre, mood, length and era, plus typo-tolerant fuzzy search.

**Together**
- Emoji reactions that float up from the sender's seat (keys `1`–`7`).
- Live chat with typing indicators.
- Shared queue with up-votes and auto-advance, and group polls whose winner joins the queue.

### Creative extras

| | |
| --- | --- |
| 🎞️ **Sync Strip** | The seek bar is a film strip. Every viewer is a pin on it (green, amber or red by drift), and reactions are stamped to the timecode so the room's best moments glow as a heat-map. |
| 💺 **Seat row** | Viewers sit in a row of cinema seats with a live drift gauge, buffering ring, host crown and typing dots. |
| 🎬 **Start together** | A ready check followed by a film-leader 3-2-1 that lands on the same instant for everyone. |
| ⏸️ **Hold for stragglers** | If someone's video is buffering, the room pauses and resumes together. |
| 📡 **Sync health** | A live panel with round trip, clock offset, your drift and the control latency your device has measured. |

## Results

Measured, not estimated. Full methods and caveats are in **[docs/LATENCY.md](docs/LATENCY.md)**.

| Requirement | Target | Measured |
| --- | --- | --- |
| Users per room | ≥ 10 | 50 seats; tested with 10, 25 and 50 simulated viewers and 11 real Chrome pages |
| Control propagation (p95) | ≤ 250 ms | **2–3 ms** on loopback, **46–47 ms** with 15 ms ± 10 ms emulated each way |
| Drift after correction | ≤ 500 ms | **max 83 ms** steady state; recovered from a 2 s error in **153 ms** |
| Reliability | late joins, reconnects, concurrent actions | All checked, including chaos runs |

Loopback is a best case. Real Wi-Fi with packet loss was not tested.

## How the sync works

```
 client ──control(play/pause/seek)──▶ server ──state{anchor, seq}──▶ every client
                                       │
                          one authoritative anchor per room
```

1. **One anchor.** The server keeps `{ videoId, status, anchorPos, anchorServerTime, seq }`. The playhead at any moment is `anchorPos + (serverNow − anchorServerTime)` while playing. A late joiner or a reconnecting client needs just one message to be correct.
2. **Synced clocks.** Each client runs NTP-style pings and keeps the median offset of its lowest-RTT samples, so everyone evaluates the anchor on the server's clock.
3. **Controls are intents.** `play`, `pause` and `seek` are idempotent, so two people pressing pause together produce one change. The server orders everything with `seq`, and clients drop anything stale. Playback starts ~180 ms in the future so everyone begins at the same instant.
4. **Drift loop** (every 250 ms): under 50 ms do nothing; up to 400 ms nudge `playbackRate` by 3–12 % (no visible jump); beyond that, hard-seek.
5. **Failure handling:** heartbeats, 30 s seat grace on reconnect, rate limits, payload caps and input sanitising. The full table is in [docs/LATENCY.md](docs/LATENCY.md).

## Project layout

```
shared/    protocol types, sync math and the movie catalog (used by server, client, tests, bots)
server/    Express + ws; src/rooms.ts is the room state machine
client/    Vite + React + TypeScript; net/ (socket, sync engine), components/, styles/
scripts/   loadtest.ts, e2e-drift.ts, verify-catalog.ts
docs/      LATENCY.md and the raw JSON results
```

**Stack:** Node, Express, `ws`, React, Vite, TypeScript, Zustand, Fuse.js, Vitest and Playwright. Fonts (Big Shoulders Display, Instrument Sans, DM Mono) are bundled, so the app works offline apart from the video itself.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `npm start` says the port is in use | Run `PORT=4010 npm start`, or stop whatever is using port 4000. |
| A friend can't open the Network link | Make sure you're on the same Wi-Fi and your firewall allows Node on port 4000. |
| The screen says "Tap to join the screening" | Your browser blocks sound until you tap once. Tap it and you're in. |
| The video stays black | Check your internet connection (videos stream from archive.org), or try another title. |
| `npm run e2e` fails | It needs Google Chrome and a small clip: `curl -L -o server/media/test-clip.mp4 https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4` |

## Notes

- Rooms live in server memory, so restarting the server closes them. There are no accounts; a viewer is a name and a seat color, and the name is never saved between visits.
- Posters are generated typography, not artwork, so there are no image licenses to worry about.
- Film licences: Blender open movies are CC BY (Blender Foundation); the other titles are public domain.

---

<div align="center">

Made with care by **Dharoon Balajii** · **VinnovateIT Recruitment'26**

</div>
