# Latency, drift and failure handling

Everything below was measured on the machine and with the scripts in this repo. Raw JSON for each run is in [`docs/results/`](results/). Nothing here is extrapolated.

## Targets

| Constraint | Target | Result |
| --- | --- | --- |
| Concurrent users per room | ≥ 10 | 50 seats (hard cap); tested with 10, 25, 50 headless viewers and 11 real browser pages |
| Playback control propagation, p95, local network | ≤ 250 ms | **2–3 ms** on loopback, **46–47 ms** with 15 ms ± 10 ms emulated each way |
| Playback drift after correction | ≤ 500 ms | **max 83 ms** steady state, **max 66 ms** after a seek storm, recovery from a 2 s error in **153 ms** |

## Test conditions

| | |
| --- | --- |
| Machine | Apple M5, 10 cores, 17 GB, macOS (Darwin 25.5.0) |
| Runtime | Node v26.0.0, `ws` without compression |
| Browser (e2e) | Google Chrome 155, headless, 11 pages in one context |
| Network | Loopback (`127.0.0.1`). **This is a best case.** A second configuration emulates 15 ms ± 10 ms one-way latency in both directions (strict FIFO, like TCP) inside the bots. It does not emulate loss or bandwidth limits. |
| Server | Single Node process, in-memory rooms |
| Video (e2e) | Sintel trailer (4.4 MB) served locally in place of the remote title, so buffering doesn't pollute the drift numbers |

### What "propagation" means

A bot calls `send()` on a control (`play`, `pause` or `seek`) and stamps the wall clock. Every **other** viewer stamps the wall clock when the resulting `state` message is delivered to application code. Server and bots share one machine clock, so there is no clock-offset error. The bot process's own event-loop lag (p95 ≈ 6 ms) is inside the numbers, which makes them conservative. In the real client, the same measurement is taken against the NTP-style synced server clock and shown live under **Sync health → Control latency here**.

Propagation covers the time until the new state reaches the viewer's code. Applying it to a `<video>` then takes one `play()` call plus decode start, which is measured separately as drift in the browser test.

## 1. Headless load test (`npm run loadtest`)

One room; a bot fires a random `play` / `pause` / `seek` every ~120 ms (≈ 8 control attempts per second) for 20 s per scenario. "Chaos" additionally reconnects ~15 % of viewers every 2 s, joins a fresh viewer every 2.5 s, and fires 5 simultaneous conflicting controls every 3 s.

**Loopback**

| Viewers | Deliveries | p50 | p95 | p99 | max | Sender ack p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 1 008 | 1 ms | **2 ms** | 2 ms | 3 ms | 1 ms |
| 25 | 2 640 | 1 ms | **2 ms** | 3 ms | 4 ms | 2 ms |
| 50 | 5 341 | 1 ms | **3 ms** | 4 ms | 4 ms | 2 ms |
| 12 + chaos | 1 300 | 1 ms | **2 ms** | 3 ms | 3 ms | 2 ms |
| 35 + chaos | 3 825 | 1 ms | **3 ms** | 4 ms | 5 ms | 3 ms |

**Emulated 15 ms ± 10 ms one-way**

| Viewers | Deliveries | p50 | p95 | p99 | max | Sender ack p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 1 053 | 32 ms | **46 ms** | 50 ms | 52 ms | 47 ms |
| 50 | 4 949 | 34 ms | **47 ms** | 50 ms | 53 ms | 46 ms |
| 12 + chaos | 1 373 | 32 ms | **45 ms** | 48 ms | 51 ms | 45 ms |
| 35 + chaos | 4 351 | 32 ms | **46 ms** | 49 ms | 52 ms | 46 ms |

Propagation tracks the network's own latency (here ≈ 2 × 15 ms plus jitter), not the viewer count. Going from 10 to 50 viewers added about 1 ms on loopback. Server RSS stayed at 79–89 MB throughout.

Invariants checked in every scenario (all held):

- **Convergence:** after the storm, every connected viewer holds the same `seq` and anchor as the server.
- **Ordering:** zero out-of-order `state` messages delivered. A stale-`seq` check on the client drops anything older.
- **Idempotence:** of ~170 control attempts per run, only ~110 changed state. The rest were duplicate plays or pauses that arrived from other viewers a moment earlier, which the server answers without a new `seq`.
- **Late joiners (chaos):** 7 of 7 received a live anchor in the snapshot, then every later state change with no gaps.
- **Capacity:** with 50 seats taken, the 51st viewer gets "This room is full (50 viewers)." and a reconnecting viewer reclaims their own seat.

Chaos runs use 12 and 35 viewers, not 50, because departed late-joiners keep their seat for the 30 s grace window and 50 leaves no free seats for them (the 50-viewer case is covered without chaos and by the capacity check).

## 2. Real-browser test (`npm run e2e`)

11 Chrome pages (10 + 1 late joiner), each with a real `<video>` decoding H.264, one room. Drift is sampled every 50 ms in every page: `video.currentTime` minus the room's expected position on the synced clock.

| Check | Result |
| --- | --- |
| 10 viewers join one room | 1.0 s for all pages |
| Ready check → 3-2-1 → synchronized start | every page playing |
| Steady-state drift, 9 s, 10 pages | \|drift\| p50 44 ms · p95 61 ms · **max 83 ms** (1 801 samples) |
| Control propagation across 24 mixed pause/play/seek commands | p50 1 ms · p95 **2 ms** · max 22 ms (234 deliveries) |
| Recover from **+2.0 s** injected drift | back within 500 ms after **153 ms** (nudge → seek → sync); 65 ms max afterwards |
| Recover from **−1.2 s** | back within 500 ms after 120 ms; 57 ms max afterwards |
| Recover from **+0.3 s** | back within 500 ms after 41 ms (rate nudge only, no seek) |
| Seek storm: 6 rounds × 6 viewers seeking at once | all 10 pages on the same `seq` (64) |
| Drift after the storm | p95 59 ms · **max 66 ms** |
| Pause | 10 of 10 players paused within 700 ms |
| Late joiner, mid-playback | playing in sync **199 ms** after opening the page; p95 drift 57 ms |
| Socket severed, room moves on, client rejoins | same seat (identity kept); drift 124 ms right after rejoin |

The ~45–60 ms steady offset is the cost of `video.play()` and decode start relative to the scheduled instant. It's inside the engine's deadband (50 ms) plus measurement noise, and far below the 500 ms limit.

## How drift is detected and corrected

Every 250 ms each client computes `drift = video.currentTime − expectedPosition(anchor, syncedServerNow)`.

| \|drift\| | Action |
| --- | --- |
| < 50 ms | Nothing |
| 50–400 ms | Nudge `playbackRate` by 3–12 % (proportional), no visible jump |
| ≥ 400 ms | Hard seek to the expected position (+40 ms to cover resume cost); 1.5 s cooldown so a struggling client can't seek-storm, falling back to a nudge in the meantime |

Each viewer reports `{pos, drift, mode, buffering, rtt}` once a second. The server fans it out as a batched `health` message (at most once per second per room), which draws the seat gauges and Sync Strip pins.

## Failure handling

| Failure | What happens |
| --- | --- |
| Two people press play/pause at the same moment | Controls are intents, so repeats are no-ops (no new `seq`); the sender still gets the current state back. Verified: 170 attempts → ~110 state changes. |
| Conflicting seeks | Server serializes; last applied wins; one `seq` order is broadcast to everyone. Clients drop stale `seq`s. Verified by the 6-way seek storm. |
| Late join | The server sends a snapshot (anchor, members, queue, polls, last 100 messages, reaction heat). The client seeks to the expected position. If the browser blocks autoplay, the stage shows "Tap to join the screening". |
| Socket drop / Wi-Fi blip | Client reconnects with exponential backoff and jitter (300 ms → 5 s), presenting its seat token. Seat, name and host role are held for 30 s. Banner: "Connection lost. Reconnecting — your seat is held for 30 seconds." |
| Second window with the same seat | The older socket is closed with a clear message; the newer one takes over. Seat tokens live in `sessionStorage`, so a second *tab* gets its own seat. |
| Half-open / dead TCP | Server pings every 10 s and terminates sockets that miss one. |
| Host leaves or vanishes | After the 30 s grace period (or on leave), host transfers to the longest-present connected member and the room is told. Manual transfer: click a seat → *Make host*. |
| Someone's video buffers | If **Hold for stragglers** is on, the room pauses and resumes after a short debounce with a scheduled start. Exempt: anyone who joined in the last 4 s. Safety valve: gives up after 15 s, then 20 s cooldown. |
| Slow consumer | A socket with > 2 MB queued is terminated rather than allowed to stall the room. |
| Control spam / chat flood | Per-member token buckets (controls, chat, reactions, reports, polls/queue). Floods are dropped; the sender is told to slow down and resynced. |
| Hostile input | Payloads capped at 16 KB; control chars stripped; names ≤ 24, chat ≤ 400 chars; only whitelisted emoji count; `seek` clamped to the video's length; unknown titles rejected; reactions with implausible timestamps are corrected to the room clock; text is rendered through React (no HTML injection). |
| A glitchy client reports `ended` early | Ignored unless the room clock is past 90 % of the runtime; with 10 clients reporting `ended`, exactly one advance happens. |
| Room full | 50-seat cap with a readable error. |
| Empty room | Garbage-collected after 10 minutes. |
| Wrong or expired room code | "Room KQTM-72 isn't open. Check the code or start a new room." |
| Server restart | Rooms are in memory and are lost. Clients see the "isn't open" message on reconnect. |

## Limits and caveats

- **Loopback is a best case.** The emulated-latency run shows the design adds ~1–2 ms on top of the network and doesn't amplify jitter, but real Wi-Fi with packet loss was not tested.
- **Real video over the internet** adds buffering the e2e test deliberately removed (it uses a local clip). The straggler hold and drift loop are the mitigation; they are unit-tested and exercised in the browser, but not under a throttled link.
- **One server process.** 50 viewers used under 100 MB and a few ms of event-loop time, but horizontal scaling (sticky sessions or a shared bus) is out of scope.
- **Chrome only** for the automated browser test. The client uses standard `<video>` APIs and has been exercised in the Claude desktop app's embedded Chromium.
- Autoplay policy is real: a device that has never been tapped needs one tap.

## Re-running

```bash
npm install
npm test                                         # 37 unit tests
npm run verify-catalog                           # catalog URLs → 206 + ranges
npm run loadtest -- --seconds=20                 # loopback; writes docs/results/loadtest-*.json
npm run loadtest -- --users=10,50 --seconds=20 --netdelay=15 --jitter=10
npm run build && npm run e2e                     # needs Google Chrome + server/media/test-clip.mp4
```

The e2e clip is the Sintel trailer (CC BY 3.0, Blender Foundation):

```bash
curl -L -o server/media/test-clip.mp4 https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4
```
