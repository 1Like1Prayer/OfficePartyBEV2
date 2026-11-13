# Netcode for a Browser-Based Fall Guys-Style Game: A Practical Engineering Breakdown (Three.js + Node.js, 2026)

For a Three.js + Node 3D party game with 10–60 players, use a **server-authoritative hybrid**. The Node server runs a fixed-tick simulation (60 Hz) and sends compact binary snapshots at 20–30 Hz. Each client **predicts only its own bean** and **reconciles** against server acks. **Remote beans and physics props are interpolated about 100 ms in the past.** **Scripted obstacles are never streamed at all**: every client computes them from a synchronized server clock and a start tick. Everything else in this report is detail on how to do those four things well, and what goes wrong when you don't.

## TL;DR

- **Architecture:** authoritative Node server with a fixed 60 Hz tick (tick number = canonical timeline). Snapshots go out at 20–30 Hz, inputs go up every tick with redundancy, and the client predicts and reconciles its own character. Remote players and server-owned physics props are interpolated with a ~100 ms adaptive buffer. Time-driven obstacles are pure functions of `serverTick`, so they cost zero bandwidth.
- **What Fall Guys actually did:** a Unity client/server game built on a hand-modified UNet with networked ragdoll physics for 60 players. The launch-era cheating (teleport/speed/fly hacks) strongly suggests movement was client-trusted. Treat that as a cost-saving shortcut you should *not* copy. Rocket League (input buffers, predict everything, 100% server authority) is the better model.
- **Transport and tooling in 2026:** start on WebSockets (`ws` or uWebSockets.js) with tight binary messages and stale-data dropping. WebTransport became Baseline when Safari 26.4 shipped it on 24 March 2026. WebKit's release post says it includes a fallback to HTTP/2 over TCP when QUIC is unavailable. But Node still has no native WebTransport and relies on `@fails-components/webtransport`, so add unreliable datagrams (WebTransport or geckos.io/WebRTC) as a phase-2 upgrade behind a transport interface. Use Rapier (WASM, cross-platform deterministic) on both client and server.

---

## Key Findings

1. **Every shipped reference game separates three timelines.** Your own character runs in the *predicted present*, the server's state is the *authoritative present*, and other entities are shown in the *interpolated past*. Rocket League's Jared Cone states the core problem directly: when the client predicts its vehicle and interpolates a server-authoritative ball, "the client's vehicle and the ball exist in two different timelines."\[1\] Most "buggy" feelings in physics party games come from interactions across these timelines, not from raw latency.
2. **Fixed tick + tick numbers beat wall-clock timestamps.** Overwatch quantizes time into fixed 16 ms command frames. Edgegap's summary of Tim Ford's GDC 2017 talk puts it this way: "the client's clock is always ahead of the server by half round-trip time plus one buffered command frame". At 160 ms RTT that is about 96 ms of lead. Rocket League runs Bullet at a fixed 120 Hz,\[1\] and Source runs 66 Hz in CS:S/TF2.\[2\] Send **tick numbers** for everything simulation-related. Use millisecond timestamps only for clock sync and diagnostics.
3. **Interpolation delay is a function of send rate and loss.** Valve's "Source Multiplayer Networking" docs give a default `cl_updaterate` of 20 and a 100 ms lerp (`cl_interp 0.1`) so that one lost snapshot is survivable. In his 2014 "Snapshot Interpolation" article, Glenn Fiedler found that "the amount of delay that works best at 2-5% packet loss is 3X the packet send rate". That is 300 ms at 10 packets/s, while 30 snapshots/s gives "the same amount of packet loss protection with a delay of 150ms". At 20–30 Hz snapshots, 2–3 intervals (~70–150 ms) is the right range.
4. **Determinism is attainable in the browser with Rapier, but you don't need full determinism.** Rapier's docs state its WASM/JS build is "fully cross-platform deterministic". The caveats: bodies, colliders and joints must be "constructed the same way" and "added/removed in the exact same order", and no `Math.sin`/`Math.cos` may feed the simulation. Use determinism for obstacles and the local character controller. Don't bet the architecture on lockstep.
5. **Browser transport is finally unblocked but immature server-side.** WebTransport is in Chrome 97+, Edge 98+, Firefox 114+ and Safari 26.4+ (Safari since 24 March 2026, per WebKit). Node, however, has no built-in support, and the main library is a libquiche binding maintained largely by one person.\[3\] WebSockets with mitigations is the pragmatic default.

---

## 1. Architecture: Who Is Authoritative?

### The three models

| Model | How it works | Pros | Cons | Use when |
|---|---|---|---|---|
| **Server-authoritative + prediction** (Quake/Source/Overwatch/Rocket League) | Clients send inputs; server simulates; clients predict self and interpolate others | Cheat-resistant, single truth, fair | Most complex; server CPU per match; corrections visible under loss | Competitive outcomes (qualification, crowns) |
| **Client-authoritative** (owner simulates, server relays) | Each client simulates its own avatar and sends positions | Trivial to build, zero input lag, cheap server | Teleport/speed hacks; player-vs-player collisions disagree; physics props have no owner | Prototypes, co-op, trusted friends |
| **Hybrid** | Server authoritative for outcomes, props and eliminations; client authority (with validation) for own movement or specific interactions | Cheap and responsive | Validation is hard to get right for physics movement | Budget-constrained casual games |

Gaffer On Games' "Networked Physics (2004)" explains why the authoritative model won in shooters. The server is "authoritative over the physics of the character so even if the client attempts to cheat all they are doing is fooling themselves locally."\[4\]

### What Fall Guys actually does (and what's only speculation)

What's confirmed from official or partner sources:
- **Engine/network stack:** The Multiplayer Group (MPG) co-developed the original prototype and core multiplayer. Their role was "dealing with the client/server model, physics, animation and player character control", using "a hand-modified version of the UNet networking library."\[5\] MPG engineer Etienne De Villiers: "Trying to get 60 physics-heavy characters in a small space all networked and playing nicely has been a really tricky, interesting and fun challenge. We had to write a new ragdoll system as the third-party one just didn't network properly and was killing the frame rate."\[6\]
- **Networked physics was the hardest problem.** In the 2020 launch AMA, a developer said: "From a purely engineering perspective, it's been the networking. It turns out making a physics oriented game with 60 players is actually quite an undertaking!"\[7\] Mediatonic's Jeff Tanton told MCV/Develop it is "fully networked physics, with 60 players all at once… There's all of these messages about where your limbs are, how you're falling, how the physics is taking effect… that was a huge overhead." He added that "sometimes the way the character moves would have to be changed, because of the problems that were being solved with the 60 player network."\[8\] Design was constrained by the netcode, not the other way round.
- **Interpolation of remote state.** The July 2021 (Season 5) patch notes list "Better netcode interpolation; should mean visuals appear smoother and more responsive" and "Character: improvements to mantling onto ledges at high latency."\[9\]\[10\]
- **Learning from Rocket League.** After the Epic acquisition, designer Joe Walsh said the team could "ask them how on earth the Rocket League physics work so well."\[11\]

What is inference, not official:
- **Movement authority at launch was probably client-trusted.** At launch, cheaters could "bypass start countdowns, move at ludicrous speeds, jump incredibly high, and teleport" (Kotaku).\[12\] Mediatonic responded with detection thresholds, a "Cheater Island" and then Epic's Easy Anti-Cheat, not with server-side rejection.\[13\]\[14\] That pattern is consistent with client-reported positions that the server weakly validates.\[15\]\[16\] No developer has confirmed this.
- **Tick/send rate.** No official figure exists. Claims of "~20–30 Hz" and "everything is server-authoritative" come from VPN-vendor marketing blogs and estimate-labeled sites, so ignore them.\[17\]\[18\]
- **Grabs.** Community reports of grabs from "a body length or two away" suggest grabs favor the grabber's view, i.e. some lag tolerance.\[19\] This is not confirmed.

**Takeaway for you:** Fall Guys shows that a physics party game can ship with generous, sloppy netcode, because the genre forgives chaos. Its own developer described it as "a physics game. Sometimes things go wrong, sometimes things are weird."\[20\] It also shows the cost of trusting clients. With a Node server and Rapier, server authority for 60 kinematic capsules is affordable, so take it.

### Other reference architectures worth stealing from

- **Quake 3 / Source (snapshot model):** the server ticks at a fixed rate and sends delta-compressed snapshots against the last acked snapshot. Clients interpolate entities ~100 ms in the past (Source: `cl_interp 0.1`, ~20 snapshots/s by default).\[21\]\[22\] The server lag-compensates hitscan by rewinding. Valve's docs give the formula `interpolation period = max(cl_interp, cl_interp_ratio / cl_updaterate)`. They also note that a Source server at tickrate 100 "generates about 1.5x more CPU load than a default tickrate 66."\[21\]
- **Overwatch (GDC 2017, Tim Ford):** fixed 16 ms command frames, client runs ahead by ½RTT + 1 buffered frame, and the server signals the client to speed up or slow down its simulation to keep the input buffer healthy. Ford warns that a server that falls behind can enter "a death spiral."\[23\]\[24\]
- **Rocket League (GDC 2018, Jared Cone):** Bullet at a fixed 120 Hz. "Client sends input for every physics frame"; "server buffers client input"; "client predicts everything" (all cars and the ball). Corrections roll back all physics actors and resimulate, which is expensive: "200ms ping, 120hz = 24 correction frames." Upstream throttle: "Buffer low? Client runs extra physics frames. Buffer full? Client runs fewer physics frames." Downstream throttle: the server "consumes 0, 1, or 2 inputs per frame." Result: "No input delay", "100% server authority", and "high-ping clients don't ruin game."\[1\]
- **Photon Fusion 2.1 (2025–2026):** tick-based client/server with full prediction and resimulation, or "Shared Mode" (client authority via a relay). Tick rate is configurable from 8 to 256 Hz, with send rate down to 1/8 of the tick. Shared Mode is capped at 32 Hz, defaulting to 32 Hz tick and 16 Hz send.\[25\] Its new **Forecast Physics** "uses extrapolation to place physics objects in the local time of all players" as a cheaper alternative to full physics resimulation.\[26\] It is a useful middle ground for props.
- **Unity Netcode for GameObjects:** `NetworkRigidbody` makes bodies kinematic on all non-authoritative instances.\[27\] Its ClientDriven sample uses **client-side detection with server-side validation** for pickups, because shared objects "are replicated with some lag."\[28\] That's the exact pattern you want for grabs.

---

## 2. Server Tick Rate and Fixed Timestep

**What:** the simulation advances in fixed `dt` steps regardless of real elapsed time. Three rates are decoupled:

| Rate | Recommended | Why |
|---|---|---|
| Simulation tick (server and client prediction) | **60 Hz** (16.67 ms) | Smooth character control and fewer tunneling issues. Rocket League notes "slower rate = larger steps = larger penetrations = inconsistent hits."\[1\] |
| Snapshot send rate (server → client) | **20 Hz** baseline, **30 Hz** if bandwidth allows | Every 3rd or 2nd tick. Bandwidth scales linearly. |
| Input send rate (client → server) | **60 Hz or 30 Hz batches** | One input per tick, batched 2 per packet at 30 Hz, each packet carrying the last ~4–8 unacked inputs redundantly |
| Render rate | Display refresh (60–144+ Hz) | Interpolate between sim ticks |

**Trade-offs:** 30 Hz simulation halves server CPU but makes jumps and collisions noticeably coarser and increases correction size. 60 Hz is the sweet spot for a character platformer. 120 Hz (Rocket League) only pays off for high-speed rigid-body contact.

**Accumulator pattern (Gaffer "Fix Your Timestep"):**\[29\]

```ts
const DT = 1 / 60;
let acc = 0, last = performance.now();

function frame(now: number) {
  acc += Math.min((now - last) / 1000, 0.25); // clamp to avoid spiral of death
  last = now;
  while (acc >= DT) {
    simulate(DT, ++localTick);   // fixed-step physics + prediction
    acc -= DT;
  }
  const alpha = acc / DT;        // render interpolation factor
  render(alpha);                 // lerp(prevState, currState, alpha)
  requestAnimationFrame(frame);
}
```

**Node.js loop precision.** `setInterval`/`setTimeout` drift by ~1–2 ms and can be late under GC or event-loop load. Pure `setImmediate` loops are precise but burn 100% of a core.\[30\] The standard fix, used by timetocode's `node-game-loop` and `node-gameloop`, mixes them.\[31\]\[32\]\[33\] You `setTimeout` until ~1–2 ms before the deadline, then `setImmediate`-spin. Always compute ticks from a monotonic clock (`process.hrtime.bigint()` or `performance.now()`), never by counting callbacks.\[34\] `@javelin/hrtime-loop` reports ~99.93% accuracy at a 16.67 ms interval using this approach.\[35\]

```ts
const TICK_NS = 16_666_667n;
let next = process.hrtime.bigint();
function loop() {
  const now = process.hrtime.bigint();
  let steps = 0;
  while (now >= next && steps < 5) { serverTick(); next += TICK_NS; steps++; } // cap catch-up
  if (steps === 5) next = now + TICK_NS; // drop time instead of death-spiraling
  const remainingMs = Number(next - process.hrtime.bigint()) / 1e6;
  remainingMs > 2 ? setTimeout(loop, remainingMs - 1.5) : setImmediate(loop);
}
```

Additional Node tips:
- Run **one match per worker thread or process**. Keep JSON parsing, matchmaking and auth off the tick thread.
- Monitor `perf_hooks.monitorEventLoopDelay()`.
- Budget the tick to under ~50% of 16.67 ms so GC pauses don't cause late ticks.

---

## 3. Client-Side Prediction and Server Reconciliation

**What:** the client applies its own input immediately, remembers it, and sends it with a sequence/tick number. When the server state arrives with `lastProcessedInputTick`, the client resets its character to the server state and **replays all unacknowledged inputs** (Gambetta Part II).\[36\]

**Why:** without it, input-to-motion delay equals the full RTT. Players perceive 100+ ms of delay as "floaty and laggy" immediately.

```ts
type Input = { tick: number; move: [number, number]; jump: boolean; dive: boolean; grab: boolean; camYaw: number };
const pending: Input[] = [];             // ring buffer in practice

function clientTick(tick: number) {
  const input = sampleInput(tick);
  pending.push(input);
  net.sendInputs(pending.slice(-6));     // redundancy: last 6 inputs per packet
  me.state = stepCharacter(me.state, input, world.at(tick)); // shared pure function
  history.set(tick, me.state);
}

function onSnapshot(s: Snapshot) {
  const ack = s.ackInputTick;
  while (pending.length && pending[0].tick <= ack) pending.shift();
  const predicted = history.get(ack);
  const auth = s.self;
  if (!predicted || distance(predicted.pos, auth.pos) > 0.01 || auth.flags !== predicted.flags) {
    const before = me.state.pos;
    let st = auth;
    for (const inp of pending) st = stepCharacter(st, inp, world.at(inp.tick)); // replay
    me.state = st;
    me.visualOffset = add(me.visualOffset, sub(before, st.pos)); // smooth, don't snap
  }
}
```

**Key requirements:**
- **The same movement code runs on client and server.** It's TypeScript in both places, so share a package. Bernier's Valve paper describes exactly this: "sharing the identical movement code for players in both the server-side game code and the client-side game code."\[37\]
- **Obstacles must be queryable at any tick** (`world.at(tick)`). Then the replay sees the beam exactly where the server saw it. This is the main reason to make obstacles time-driven (§5).
- **Smooth corrections, don't snap.** Keep the physics position correct immediately but render `pos + visualOffset`, decaying the offset with a ~80–150 ms half-life (e.g. `offset *= Math.exp(-dt / 0.1)`). Snap only if the error exceeds ~2–3 m (teleport/respawn).
- **Full determinism isn't required.** Small float drift is corrected every snapshot. Determinism only has to be "good enough" that corrections are rare and tiny.

**When prediction is not worth it:** predicting ragdoll states, being knocked by other players, or conveyor and physics-prop contacts gives poor results, because the client lacks other players' future inputs. A common approach is to predict only voluntary locomotion (run, jump, dive), and to let the server own "stunned/ragdolled" states. While stunned, render your own bean from interpolated server state, which feels natural because you've lost control anyway.

---

## 4. Entity (Snapshot) Interpolation for Remote Players

**What:** buffer snapshots and render remote entities at `renderTime = estimatedServerTime − interpDelay`, interpolating between the two snapshots that bracket `renderTime`.

**Parameters:**
- **Interp delay:** 2–3 snapshot intervals. Source: 100 ms at ~20 Hz, so "even if one snapshot is lost, there are always two valid snapshots to interpolate between".\[22\] Fiedler: "my rule of thumb is that the interpolation buffer should have enough delay so that I can lose two packets in a row and still have something to interpolate towards", which works out to ~3× the send interval at 2–5% loss.\[38\] At 10 Hz, "the minimum interpolation delay is 100ms, and a more practical minimum considering network jitter is 150ms."\[39\] For you, that's **~100 ms at 20 Hz, ~70–100 ms at 30 Hz**.
- **Adaptive delay:** measure snapshot inter-arrival jitter (EWMA of deviation). Set `interpDelay = sendInterval × 2 + k × jitter`, clamped to 60–250 ms. Change it slowly by time-scaling render time ±5%, never by jumping.
- **Loss:** skip missing snapshots and interpolate to the next one. Never wait for a resend.\[40\]
- **Buffer underrun:** extrapolate (dead reckon) using last velocity for **at most ~100–250 ms**, then freeze or ease. Fiedler notes extrapolation breaks down for physics because it "doesn't know anything about the physics simulation", so collisions and direction changes produce visible pops.
- **Interpolation function:** linear lerp for position is fine at 20–30 Hz. **Hermite** (position plus velocity at both ends) removes the "polyline" look of arcs and jumps, at the cost of sending velocity (which can be quantized coarsely). Use **quaternion slerp/nlerp** for rotation. Use nlerp for small angles because it's cheap, and always take the shortest path (`if dot < 0 negate`).

```ts
function sampleRemote(buf: Snap[], renderTick: number): Pose | null {
  // find a = last snap with tick <= renderTick, b = first with tick > renderTick
  const t = (renderTick - a.tick) / (b.tick - a.tick);
  return { pos: hermite(a.pos, a.vel, b.pos, b.vel, t, (b.tick - a.tick) * DT),
           rot: nlerpShortest(a.rot, b.rot, t), anim: t < 0.5 ? a.anim : b.anim };
}
```

Use `renderTick` as a fractional tick, e.g. `serverTickEstimate - interpDelayTicks`. `@geckos.io/snapshot-interpolation` implements this vault/buffer pattern in JS and is worth reading. Note that its last release (1.1.1) was in February 2025, so treat it as a reference implementation rather than an actively evolving dependency.\[41\]

---

## 5. Moving Objects and Obstacles

This is the heart of your "how to handle incoming/moving objects" question. Classify every object by *who can change its motion*:

### A. Deterministic / scripted obstacles: don't stream them

Rotating beams, pendulums, sweepers, moving platforms, lasers, conveyor speeds and timed tile drops are all pure functions of time. Ship the level with a description, then send **one reliable event**: `{type: "roundStart", startTick, seed}`. Every client computes:

```ts
function sweeperAngle(tick: number, o: Obstacle) {
  const t = (tick - o.startTick) * DT;                       // seconds since start, from tick math
  return o.phase + o.angularSpeed * t;                       // avoid Math.sin in sim-critical paths
}
// Pendulum: precompute a lookup table (or use a polynomial approximation) shipped with the level,
// so client and server get bit-identical values.
```

- **Benefits:** zero bandwidth, zero jitter, and the beam renders at the *same* time as the server sees it. You can evaluate it at the predicted tick for your own collisions, so no timeline mismatch.
- **Randomness:** seed a deterministic PRNG (e.g. mulberry32/xoshiro) with the round seed. "Random" patterns, such as which tiles fall or which door is real, are then reproducible. Send secrets (e.g. the real door) only when revealed if cheating matters.
- **Rapier caveat:** obstacle transforms fed into physics should come from deterministic arithmetic. Rapier's docs warn that `Math.sin`/`Math.cos` "are not cross-platform determinism and may give different results on different platforms."\[42\] Use lookup tables or your own polynomial approximations.
- **Projectiles on fixed paths** (cannon balls, fruit, logs on fixed lanes): send `spawn {id, spawnTick, origin, velocity, pathId}` reliably once, and every client simulates the analytic path. Only send a correction or despawn event if something deflects it.
- An open-source Fall Guys-style hobby project ("Wacky Walk") documents exactly this: "Obstacles are pure functions of the shared course clock + seed… so nothing about them is synced."\[43\]

### B. Server-simulated dynamic objects: stream state, interpolate

Balls (Fall Ball), pushable blocks, eggs, seesaws driven by player weight, and destructible bits all depend on player contacts, so they must be server-simulated:
- Send `pos/rot` (and velocity for Hermite) in snapshots. Interpolate them with remote players at the same `renderTick`.
- Use **priority + rest detection** (§7): at-rest objects cost ~1 bit. Fiedler recommends bumping the priority of objects that just came to rest until acked, so they don't settle in the wrong place on clients.\[44\]
- **Seesaws/hinged platforms:** these are dynamic but low-dimensional, so send just the angle (one quantized uint16).

### C. Ownership/authority transfer

When a client is clearly the only one interacting with a prop (e.g. carrying an egg), you *can* give temporary client authority for responsiveness. That is the Photon Shared Mode / Unity owner-authority pattern. The server validates position deltas and reclaims authority on contact with another player or on timeout. For a competitive party game, prefer server authority plus a predicted "carried" attachment: the carried object is rendered parented to your predicted hand.

### D. Your predicted bean vs interpolated-past things

This is the classic bug source. Your bean is ~½RTT+ ahead of server time, while remote beans and props are ~interpDelay behind. On your screen you collide with a remote bean's *old* position. Remedies:

1. **Time-driven obstacles are evaluated at your predicted tick**, so they're consistent (category A solves the biggest case).
2. **Remote players:** don't hard-collide against interpolated capsules in prediction. Treat them as *soft* (a push/repulsion force, or no collision locally) and let the server's authoritative bump arrive as a correction. Fall Guys-style chaos hides this well.
3. **Dynamic props you hit:** Rocket League's answer is to *predict everything*, i.e. extrapolate the ball forward to your timeline. It "works well with ball (predictable)" but "not as well with cars (unpredictable)."\[1\] A cheaper option (similar to Photon's Forecast Physics) is to extrapolate *only nearby* props into your predicted timeline using velocity, and blend back to interpolated time as they move away.
4. **Grabs/pushes:** client detects locally (instant animation), server validates with rewind (§9), and the server sends the authoritative result.

### E. Player-vs-player collisions

On the server, beans should collide normally (capsule–capsule), but tune it to be *forgiving*: soft repulsion rather than rigid contacts, capped impulse, and short stun only from deliberate actions (dive, grab, obstacle hit). Bumping between two predicted clients produces "ping-pong" corrections. Keep incidental bumps small so corrections stay under the smoothing threshold. Fall Guys' team said they changed character movement "because of the problems that were being solved with the 60 player network."\[8\] Do the same: let netcode constraints inform game feel.

---

## 6. Time Synchronization

**Use tick numbers as the canonical timeline.** Wall-clock timestamps only exist to *estimate* the current server tick.

**NTP-style offset estimation (ping/pong):**

```ts
// client sends {t0}; server replies {t0, t1: recvTime, t2: sendTime, serverTick}
const rtt = (t3 - t0) - (t2 - t1);
const offset = ((t1 - t0) + (t2 - t3)) / 2;   // server clock − client clock
```

- Ping every ~1 s (more often for the first 3–5 s). Keep the last ~10–20 samples and **trust the samples with the lowest RTT**, since they have the least queuing asymmetry. Use a median or min-RTT filter.
- **Never jump the clock.** Slew it: run the client tick clock at 0.95–1.05× until the error is gone. Hard-reset only if the error is > ~250 ms.
- Server tick estimate: `serverTickNow ≈ lastSnapshotTick + (now − arrivalTime + oneWayEstimate)/DT`.
- **Client prediction tick** = `serverTickNow + ceil((RTT/2 + inputBufferTarget)/DT)`. This is Overwatch's "½RTT + one buffered frame".\[24\]
- **Render tick for remote objects** = `serverTickNow − interpDelay/DT`.
- **Scripted obstacles:** render at the *predicted* tick for collision-relevant ones near you. That keeps visuals and your local collision consistent. Rendering them at interpolated time while you collide at predicted time is a classic "I got hit by a beam that was clearly past me" bug.

**When to send what:**
| Data | Send as |
|---|---|
| Round start, obstacle phases, spawns | `startTick` (+ seed) once, reliable |
| Inputs | `tick` + compact bitfield, redundant |
| Snapshots | `serverTick` + `ackInputTick` per client |
| Remote player/prop state | Exact (quantized) positions in snapshots, never velocities alone |
| Eliminations, qualifications, scores | Reliable events carrying the `tick` they happened |
| Clock sync | Millisecond timestamps (`performance.now()`), ping/pong only |

---

## 7. What to Send and When

**Inputs up, state down.** Clients never send positions in an authoritative model. That alone kills teleport hacks.

**Snapshot design:**
- **Delta compression against an acked baseline** (Quake 3 / Fiedler "Snapshot Compression"): "the receiver has to continually send 'ack' packets back to the sender saying: 'the most recent snapshot I have received is snapshot n'". The server encodes the next snapshot relative to it.\[39\] Keep a ring buffer of ~32–64 snapshots per client. If the baseline is too old, send a full snapshot. On **WebSockets** (reliable and ordered) you can simplify to "delta vs previous sent". That works because TCP guarantees delivery, though a stall then delays everything.
- **Events vs state:** one-off happenings such as spawn, eliminate, round start/end, emote, qualification and grab-success go on a **reliable** channel as typed RPCs with a tick. Continuous state goes in snapshots.
- **Quantization** (typical for a ~250 m course):
  - Position: fixed-point at 1/512 m (~2 mm) in a bounded box, packed as ~17–18 bits per axis, or simply 3× int16 at 1/128 m (~8 mm) over ±256 m.
  - Rotation: beans mostly yaw. Send **yaw as uint16** while upright, and switch to **smallest-three quaternion** (2-bit index + 3 × 10-bit components = 32 bits) while ragdolling/tumbling.
  - Velocity (for Hermite): int16 at 1/64 m/s or coarser. Fiedler: velocity is "only… a hint" so "we can be pretty rough with compression."\[39\]
  - Animation state: a uint8 enum plus a normalized time uint8.
  - Rough per-bean cost: ~12–16 bytes. 60 beans × 14 B × 20 Hz ≈ **17 KB/s (~135 kbit/s) per client** before delta and AOI savings, and ~1 MB/s server egress per 60-player match. That's comfortable, but rest detection and AOI make it far smaller.
- **Serialization in JS:** hand-written `DataView`/`ArrayBuffer` writers give the smallest output and no GC churn (reuse buffers). FlatBuffers and MessagePack are fine for events, not for hot snapshots. **Colyseus schema** gives automatic incremental state sync: its benchmark shows updating x/y of 1 entity at 9 bytes vs 26 for msgpack+fossil-delta.\[45\] But its change-tracking model is a state-sync abstraction, not a tick-indexed snapshot system, so you'd still need your own interpolation and prediction.
- **Interest management (AOI):** in a gauntlet, beans far behind or ahead matter less. Use distance-based priority, not hard culling. 60 beans are all potentially visible on a wide course.
- **Priority accumulator (Fiedler, "State Synchronization"):** "each frame we add the current priority for each object to its priority accumulator value then sort objects… take the n most important… reset the priority accumulator to zero for objects that fit."\[46\] Give a per-client packet budget (e.g. 1,200 bytes) and fill it by priority. You get graceful degradation under congestion for free.
- **Send-rate throttling:** if a client's `ws.bufferedAmount` grows (TCP backlog), reduce its snapshot rate (30→20→10 Hz) and its priority budget rather than letting the queue grow.

---

## 8. Transport for Browsers (Status: November 2026)

| Transport | Delivery | Browser support | Node server options | Verdict |
|---|---|---|---|---|
| **WebSocket** | TCP, reliable, ordered (head-of-line blocking) | Universal | `ws`, uWebSockets.js, Colyseus | **Start here** |
| **WebRTC DataChannel** | SCTP over DTLS/UDP; can be `ordered:false, maxRetransmits:0` | Universal | `node-datachannel`, geckos.io v3 (built on node-datachannel, ESM, Node ≥16)\[47\] | Proven unreliable channel; heavier setup (ICE/STUN, sometimes TURN) |
| **WebTransport** | QUIC (HTTP/3): unreliable datagrams + independent streams | **Baseline since March 2026**: Chrome 97+, Edge, Firefox 114+, Safari 26.4+ (with HTTP/2-over-TCP fallback when QUIC is blocked)\[48\] | `@fails-components/webtransport` (C++ binding to libquiche, largely single-maintainer);\[3\] Colyseus 0.16+ has *experimental* WebTransport | The future; production-risky on Node today |

**Why it matters:** with TCP, one lost packet stalls every later packet until it's retransmitted, typically ~1 RTT+. At 1–2% loss that shows up as periodic 100–300 ms freezes followed by a burst. Fiedler's demonstration showed TCP-based sync "degrades terribly as packet loss and latency increases."\[49\] Note that WebTransport's HTTP/2 fallback is also TCP, so you inherit head-of-line blocking whenever QUIC is unavailable.

**If you stay on WebSockets (recommended for v1), mitigate:**
1. Disable Nagle (`socket.setNoDelay(true)`). Verify your library does it.
2. Make snapshots **self-sufficient** (absolute state, or delta vs acked baseline) so that when a burst arrives after a stall, the client applies only the **newest** and drops the rest.
3. Size the interpolation buffer adaptively. After a stall, catch up by time-scaling to ~1.1× rather than jumping.
4. Keep messages small (under ~1.2 KB) to minimize segments at risk.
5. Watch `bufferedAmount` per client and throttle (§7).
6. Put the transport behind an interface (`send(reliable|unreliable, bytes)`), so swapping to WebTransport datagrams or geckos.io later is a config change.

---

## 9. Lag Compensation and Fairness

- **Server-side rewind** (Bernier/Valve): the server keeps a ~1 s history of player and prop colliders per tick. When a grab or dive arrives stamped with the client's `renderTick` for the target, the server rewinds the target to that tick, tests the hit, then applies the result now. Cap the rewind at ~200–250 ms.
- **Trade-off:** favor-the-attacker feels great for the grabber and terrible for the victim. Bernier: a lagged player can appear to have "shot around a corner."\[50\] For Fall Guys-style grabs, use **partial compensation**: rewind up to ~100–150 ms, plus a slightly generous grab radius. Never compensate obstacle hits. Obstacles are time-driven and already consistent at your predicted tick.
- **Input jitter buffer on the server:** hold each client's inputs in a per-client queue and consume exactly one per tick. Aim for 1–2 ticks of buffer. If an input is missing, repeat the last one (Rocket League: "runs physics using previous player input").\[1\] When the late real input arrives, discard it, and the client gets corrected.
- **Time dilation / client speed-up:** the server reports each client's buffer depth in snapshots. If depth < 1, the client runs its tick clock ~2–5% faster. If > 3, it runs slower. This is the Overwatch/Rocket League "upstream throttle".\[1\]\[24\] Keep the server-side "consume 2 inputs" downstream throttle as an emergency valve only, since Cone noted it causes "minor desyncs."\[1\]
- **High ping / loss:** above ~200 ms, increase redundancy (send the last 8–10 inputs), widen the interp buffer, and lower correction sensitivity. Optionally add 1–2 ticks of **input delay** for everyone to reduce mispredictions. Photon added an input-delay option for exactly this ("Input Delay helps reduce resimulation cost").\[51\]

---

## 10. Physics Specifics

**Engine choice:**
- **Rapier (`@dimforge/rapier3d` / `-compat`, plus `-deterministic` variants):** WASM, fast, has a built-in `KinematicCharacterController`, supports `world.takeSnapshot()`, and the JS build is "fully cross-platform deterministic" (same version, same initial conditions, same insertion order).\[42\]\[52\] **Recommended.**
- **cannon-es:** pure JS and easy, but slower and not deterministic across engines. OK for prototypes.
- **Jolt (WASM):** very capable, with a heavier API surface.

**Kinematic controller vs dynamic rigid body for players.** Use a **kinematic character controller** (capsule + custom velocity integration: gravity, ground friction, slide, knockback impulse) for the networked player. It's cheap to resimulate for reconciliation (only *your* character replays, not the world). It's stable at 60 Hz and easy to make deterministic. Fake the "wobbly" Fall Guys look with procedural animation and spring bones on the client. The look is cosmetic, not physics. Switch to a server-owned ragdoll or dynamic body only during knockouts, and interpolate it.

**Fiedler's taxonomy, applied:**
| Technique | What's sent | Fit for you |
|---|---|---|
| Deterministic lockstep | Inputs only | ✗ for 60 browser players: one slow peer stalls all, and full-world determinism across 60 clients is fragile |
| Snapshot interpolation | Full visual state, interpolated | ✓ for remote players and props |
| State synchronization | Inputs + state, both sides simulate, priority accumulator | ✓ for nearby props you need in your timeline (Forecast-style) |
| Rollback (predict everything, resim) | Inputs + corrections | Rocket League-grade feel but 60 players × resim is too expensive in JS; ✗ except for your own character |

**Winner: a mix.** Prediction and reconciliation for self, snapshot interpolation for others, analytic time functions for obstacles, and optional state-sync-style extrapolation for nearby props.

**JS float determinism notes:**
- JS arithmetic is IEEE-754 double, so `+ − × ÷ sqrt` are deterministic, but `Math.sin/cos/exp/pow` may differ across engines.
- Rapier runs in f32 inside WASM, while your TS code uses f64. Round-trip values through `Math.fround` when feeding Rapier from TS if you want bit-identical inputs.
- Iteration order matters: use arrays sorted by entity ID, not `Map` iteration over insertion-order-dependent sets created differently on client and server.

---

## 11. Rendering Smoothness

- **Render interpolation between fixed ticks** (`alpha = acc/DT`) for your own bean. Without it, 60 Hz sim on a 120/144 Hz display stutters.
- **Correction smoothing:** keep a visual error offset (position and yaw) that decays exponentially (half-life ~100 ms). Snap only on teleport/respawn.
- **Camera:** follow the *smoothed visual* position with a critically damped spring (e.g. ~0.1–0.15 s), never the raw physics position. Camera jitter is the #1 perceived "lag."
- **Hide latency with animation:** play jump/dive/grab anticipation frames instantly on input. Play hit reactions locally on predicted contact, then confirm or soften. Use squash-and-stretch and particles to mask small corrections. Delay "you're eliminated" UI until the server event arrives (it's a reliable event anyway).
- **Remote animation:** drive it from the interpolated velocity plus the anim enum, not from raw network events.

---

## 12. JS/TS Frameworks and Libraries (Status: Late 2026)

| Library | What it gives you | Status | Recommendation |
|---|---|---|---|
| **Colyseus** | Rooms, matchmaking, schema delta-sync, reconnection; uWebSockets transport; experimental WebTransport | Active: 0.16 (Feb 2025: StateView, experimental WebTransport), 0.17 (Feb 2026: automatic reconnection, full-stack TS safety, `defineServer()`)\[53\]\[54\] | **Use for rooms, matchmaking and lobby/meta state.** Run your own tick loop and binary snapshot channel inside the room for gameplay. |
| **ws / uWebSockets.js** | Raw WebSocket servers | Mature | Use directly if you skip Colyseus |
| **geckos.io** | UDP-like WebRTC DataChannels between browser and Node | v3 on node-datachannel; repo activity through March 2026\[47\]\[55\] | Phase-2 unreliable transport option |
| **@geckos.io/snapshot-interpolation** | Snapshot vault, interpolation, helpers for reconciliation/lag-comp | Last release 1.1.1 (Feb 2025), single maintainer\[41\] | Study or borrow; fine to vendor |
| **node-datachannel** | libdatachannel bindings for Node | Active | Lower-level WebRTC |
| **@fails-components/webtransport** | HTTP/3 WebTransport server for Node (libquiche) | Used by MDN examples and Socket.IO/Colyseus experiments\[56\]\[57\] | Prototype only until the Node ecosystem matures |
| **Rapier JS** | Physics + character controller, deterministic build | Active | **Use on client and server** |
| **Photon Fusion / Quantum** | Best-in-class tick/prediction (Fusion) and deterministic rollback (Quantum) | Unity-focused | Study the docs, not usable for Three.js |
| **Nakama** | Matchmaking, social and authoritative match handlers (TS runtime) | Active | Alternative to Colyseus for backend services |
| **Lance.gg** | Older JS netcode framework (prediction, interpolation) | Unmaintained for years | Read for ideas only |
| **Hathora** | Was a hosting/orchestration provider for game servers | Verify current status before depending on it | Don't architect around it |
| **Gambetta's live demo** | <500 lines of JS showing prediction/reconciliation/interpolation | Stable reference | Read first |

---

## 13. Debugging and Testing

**Simulate bad networks from day one.** Build a `NetConditioner` into both client and server that wraps send/receive with configurable latency (e.g. 50/100/200 ms), jitter (±20–50 ms), loss (1/5/10%; only meaningful on unreliable transports, while on TCP you simulate *stalls*), and duplication/reordering. OS-level tools for full-stack tests: `tc netem` (Linux), clumsy (Windows), Network Link Conditioner (macOS).

**Debug overlay (toggle with a key):** RTT, jitter, clock offset, `serverTick`/`predictedTick`/`renderTick`, interp delay, snapshot buffer depth, server input-buffer depth, corrections/sec and average correction magnitude, bytes/s up/down, and extrapolation time. Draw **ghosts**: the raw server position (wireframe) vs predicted/visual position for your bean, and the latest snapshot position vs interpolated position for others.

**Metrics to log server-side:** tick duration p50/p99, late ticks, per-client input-buffer underruns, resends/backlog (`bufferedAmount`), and correction rate per player. Rocket League's Q&A highlighted tracking corrections as a primary health metric.\[58\]

**Common bugs → root cause → fix:**
| Symptom | Likely cause | Fix |
|---|---|---|
| Rubber-banding on own bean | Client and server movement code diverge (different dt, constants, obstacle timing); or input buffer underruns on server | Share code; evaluate obstacles via `world.at(tick)`; time dilation for input buffer |
| Constant micro-jitter on own bean | Applying corrections every snapshot even when tiny; snapping | Error threshold (~1 cm) + visual offset smoothing |
| Remote beans stutter | Interp delay too small for jitter; using arrival time instead of server tick | Adaptive delay; interpolate by tick |
| Remote beans "speed up then pause" | TCP stall then burst | Drop stale snapshots; time-scale catch-up |
| Teleporting remotes | Buffer underrun → long extrapolation, or full-state resync | Cap extrapolation; increase buffer; ensure acked baselines |
| Hit by an obstacle that visually missed | Obstacle rendered in interpolated time, collision in predicted time (or vice versa) | Render collision-relevant obstacles at predicted tick |
| Desync after round start | Clients start obstacles from local time on event receipt | Use `startTick`, never "on message" time |
| Server slows under load | Tick > budget → catch-up death spiral | Cap catch-up steps; profile; move work off tick thread |
| Physics differs client/server | Non-deterministic math, insertion order, f32/f64 mismatch | Lookup tables, sorted IDs, `Math.fround` |

---

## 14. Recommended Architecture for This Project

### Concrete parameters (starting values)

| Parameter | Value |
|---|---|
| Sim tick (server and client prediction) | **60 Hz** (`DT = 1/60`) |
| Snapshot rate | **20 Hz** (every 3rd tick); try 30 Hz if bandwidth allows |
| Input packets | 30–60 Hz, each with last **6** inputs (redundancy) |
| Interp delay | **100 ms** start, adaptive 60–200 ms |
| Max extrapolation | 150 ms |
| Server input buffer target | 1–2 ticks; client time-dilation ±5% |
| Correction threshold / smoothing | 1 cm / ~100 ms half-life; snap > 2.5 m |
| Lag comp max rewind (grabs) | 150 ms |
| History buffers | 64 ticks (client prediction), 60 ticks (server colliders) |
| Clock sync | Ping 1 Hz, min-RTT of last 16 samples, slew only |
| Snapshot budget | ≤ 1,200 B/packet per client, priority accumulator |

### Message formats (binary, little-endian)

```ts
// C→S  INPUTS (unreliable when available; WS otherwise)
// u8 type=1 | u32 firstTick | u8 count | count × { i8 moveX, i8 moveY, u16 camYaw, u8 buttons(jump|dive|grab) }
// C→S  ACK + PING
// u8 type=2 | u32 lastSnapshotTick | f64 t0
// S→C  SNAPSHOT
// u8 type=10 | u32 serverTick | u32 baselineTick | u32 ackInputTick | u8 inputBufferDepth
//      | self: full state (pos f32×3, vel i16×3, flags u8, stunTicks u8)
//      | u8 nEntities | n × { u16 id, u8 dirtyMask, [pos 3×i16 @1/128m], [yaw u16 | quat smallest-3 u32], [vel 3×i16], [anim u8, animT u8] }
// S→C  EVENT (reliable): u8 type=20 | u32 tick | u8 kind | payload  (roundStart{startTick,seed,levelId}, spawn, eliminate, qualify, grabResult, roundEnd)
// S→C  PONG: u8 type=3 | f64 t0 | f64 t1 | f64 t2 | u32 serverTick
```

### Decision table: object type → technique → data sent

| Object type (examples) | Sync technique | Data sent | Client renders at |
|---|---|---|---|
| **Local player** | Prediction + reconciliation (kinematic controller) | Inputs up; authoritative self-state + `ackInputTick` down | Predicted tick (+ visual offset smoothing) |
| **Remote players** | Snapshot interpolation (Hermite pos, nlerp rot) | Quantized pos/yaw(/quat)/vel/anim in snapshots, priority-scheduled | `serverTick − interpDelay` |
| **Scripted obstacles** (spinners, pendulums, platforms, lasers, timed doors) | Deterministic time function | One reliable `roundStart{startTick, seed}` | Predicted tick |
| **Fixed-path projectiles** (cannon balls, rolling logs on lanes) | Analytic path from spawn event | Reliable `spawn{id, spawnTick, origin, vel, pathId}`; `despawn` | Predicted tick near you, otherwise interpolated |
| **Player-driven physics props** (balls, eggs, pushable blocks) | Server physics + snapshot interpolation; optional local extrapolation when near you | Quantized pos/quat/vel; rest bit; priority boost on change | Interpolated (extrapolated near you) |
| **Hinged/1-DOF props** (seesaws, swinging doors pushed by players) | Server physics, interpolated scalar | One u16 angle (+ angular vel) | Interpolated |
| **Tiles that vanish** (Hex-A-Gone-style) | Server event | Reliable `tileState{tick, id, state}` | Apply at event tick (play the fall animation locally) |
| **Grabs/dives/bumps** | Client predicts animation; server validates with rewind | Input bits; reliable `grabResult` | Immediately (animation), confirmed later |
| **Ragdolled/stunned player** | Server-owned state, interpolated (even for self) | Snapshot state + stun flag | Interpolated |
| **Eliminations, qualification, scores, round flow** | Reliable events | Typed RPC with tick | On receipt |
| **Cosmetics, emotes, chat** | Reliable events, low priority | Small RPCs | On receipt |

### Prioritized implementation roadmap

1. **Shared simulation package (week 1–2):** TS monorepo with `shared/` containing the fixed-step `stepCharacter(state, input, world, tick)`, obstacle time functions, PRNG, quantization helpers and message codecs. Unit-test that client and server produce identical results for recorded input streams.
2. **Authoritative server loop:** Node worker per match, hrtime hybrid loop at 60 Hz, Rapier world with static level and kinematic character controllers, per-client input buffers.
3. **Transport layer v1:** `ws` or uWebSockets.js (or Colyseus rooms carrying your own binary messages), binary codec, `NetConditioner`, ping/pong clock sync. Put it behind a `Transport` interface.
4. **Snapshot interpolation for remote beans:** tick-based buffer, adaptive delay, debug ghosts. Ship a playable "everyone walks around" build here and test at 150 ms ± 30 ms.
5. **Client prediction and reconciliation for self,** with visual-offset smoothing and render interpolation. Target: zero corrections on a clean link, rare small ones at 150 ms.
6. **Time-driven obstacles** with `roundStart{startTick, seed}`, rendered at predicted tick. This is where "Fall Guys feel" starts.
7. **Server-simulated props** (one ball or egg) with priority accumulator, rest detection and near-player extrapolation.
8. **Player interactions:** soft bean-vs-bean bumps on the server, grabs with client-side detection, server rewind validation and a 150 ms cap.
9. **Delta compression against acked baselines, quantization tuning, priority budgets.** Measure bytes/s at 60 players with bots.
10. **Time dilation for input buffers, adaptive interp, extrapolation caps, stale-snapshot dropping** (the hardening pass).
11. **Load test:** 60 bot clients per match, measure tick p99 and server CPU, and determine matches per core.
12. **Phase 2 transport:** add WebTransport datagrams (or geckos.io) for snapshots and inputs, keep WebSocket for reliable events and fallback, and A/B test feel at 1–3% loss.

---

## Caveats

- **Fall Guys internals are not publicly documented in detail.** No GDC/Unite netcode talk exists that I could find. Claims here about client-trusted movement are *inferences* from the cheating history, and all specific tick-rate figures circulating online are unsourced marketing estimates. The richest unexamined primary source is the 2020 *Game Maker's Notebook* podcast with Mediatonic lead client engineer Joel Herber.\[59\]
- **Numeric recommendations are starting points, not laws.** Tune interp delay, send rate and smoothing against real telemetry from your player base's geography.
- **WebTransport on Node is the weakest link of the 2026 stack.** The protocol is still an IETF draft, and the W3C API only became a Candidate Recommendation on 30 July 2026. Fora Soft's summary says the IETF drafts are still in Working Group Last Call. Re-evaluate before committing.
- **Rapier's determinism guarantee covers Rapier itself.** Your TS glue (trig, iteration order, f64→f32 conversion) can still break it. Full lockstep is not recommended regardless.
- **Library status changes fast.** Verify maintenance (last release, open issues) of geckos.io, snapshot-interpolation and any hosting provider before production use.

## Sources

1. <https://media.gdcvault.com/gdc2018/presentations/Cone_Jared_It_Is_Rocket.pdf>
2. [source\_multiplayer\_networking.md · GitHub](https://gist.github.com/CoolOppo/fe0586836de3fb2f90f9)
3. [WebTransport Explained: A Real WebSocket Alternative Now — CODERCOPS](https://blog.codercops.com/blog/webtransport-explained-websocket-alternative-2026)
4. [Networked Physics (2004)](https://gafferongames.com/post/networked_physics_2004/)
5. [Fall Guys 2 – The Multiplayer Group](https://www.themultiplayergroup.com/case-studies/fall-guys-2)
6. <https://www.themultiplayergroup.com/case-studies/fall-guys>
7. [\[2020\] \[AMA\] We are the Fall Guys Dev Team, ask us anything!](https://devtrackers.gg/fall-guys/p/0558ec99-ama-we-are-the-fall-guys-dev-team-ask-us-anything)
8. ["There’s literally no way we could have made the impact that we did without PS Plus"](https://mcvuk.com/business-news/theres-literally-no-way-we-could-have-made-the-impact-that-we-did-without-ps-plus-how-fall-guys-became-an-overnight-sensation/)
9. [Fall Guys on X: "✅ Better netcode interpolation; should mean visuals appear smoother and more responsive ✅ Egg physics have been improved ✅ Character: improvements to mantling onto ledges at high latency ✅ The active player indicator will now move without jitter" / X](https://twitter.com/FallGuysGame/status/1417167731556761604?lang=en)
10. [Fall Guys: Season 5 Patch Notes - Store History and Cosmetics Database](https://fallguysstore.com/fall-guys-season-5-patch-notes/)
11. [One Year On, Mediatonic Discusses The Immense Success Of Fall Guys](https://www.gamebyte.com/fall-guys-developer-interview-egx-2021/)
12. [Fall Guys Has A Hacker Problem, But Developers Are Starting To Issue Bans - Kotaku](https://kotaku.com/fall-guys-has-a-hacker-problem-but-developers-are-star-1844685531)
13. [Fall Guys once had a secret 'Cheater Island,' but had to close it down](https://www.pcgamer.com/fall-guys-once-had-a-secret-cheater-island-but-had-to-close-it-down/)
14. [Games That Were Ruined By Too Many Cheaters - SVG](https://www.svg.com/257502/games-that-were-ruined-by-too-many-cheaters/)
15. [A History of Anti-Cheat Techniques in Video Games, from Server-Side Code to Kernel Level - The Gistre Blog](https://blog.gistre.epita.fr/posts/lucas.demenais-2025-06-24-history_of_anticheat/)
16. [what anti cheat is there :: Fall Guys General Discussions](https://steamcommunity.com/app/1097150/discussions/0/2918850377454227696)
17. [Multiplayer Game Tick Rates & Packet Sizes Database - PingPacketTest](https://pingpackettest.com/supported-games)
18. [Fall Guys Kuwait: Fix Lag, Phantom Grabs & Disconnects (2026)](https://noping.com/blog/fall-guys-kuwait-fix-lag-phantom-grabs-disconnects-2026)
19. [steamcommunity.com](https://steamcommunity.com/app/1097150/discussions/0/3075370188242325017)
20. [The big Fall Guys interview: streaming success, memes, and more - The Loadout](https://www.theloadout.com/fall-guys/launch-interview)
21. [Source Multiplayer Networking - Valve Developer Community](https://developer.valvesoftware.com/wiki/Net_graph)
22. [Steam Community :: Guide :: Source Multiplayer Networking](https://steamcommunity.com/sharedfiles/filedetails/?id=527313998)
23. [Game Backend Deep Dive - Overwatch](https://edgegap.com/blog/game-backend-deep-dive-overwatch-2016-netcode-architecture-rollback)
24. [Command Frames and Tick Synchronization - GameDev.net Forums](https://gamedev.net/forums/topic/696756-command-frames-and-tick-synchronization/)
25. [Network Project Config - Fusion 2 Introduction - Photon Engine](https://doc.photonengine.com/fusion/current/manual/network-project-config)
26. [Photon Fusion 2](https://doc.photonengine.com/fusion/v2/getting-started/release-notes/whats-new-2-1)
27. [Physics](https://docs.unity3d.com/Packages/com.unity.netcode.gameobjects@2.5/manual/advanced-topics/physics.html)
28. [github.com](https://github.com/Unity-Technologies/com.unity.multiplayer.docs/pull/865/files)
29. [Gaffer on Games](http://vodacek.zvb.cz/archiv/681.html)
30. [GitHub - timetocode/node-game-loop: node.js accurate game loop · GitHub](https://github.com/timetocode/node-game-loop)
31. [function node-gameloop.clearGameLoop (loopId)](https://npmdoc.github.io/node-npmdoc-node-gameloop/build/apidoc.html)
32. [node-gameloop - npm](https://www.npmjs.com/package/node-gameloop)
33. [an accurate node.js game loop inbetween setTimeout and setImmediate](https://timetocode.tumblr.com/post/71512510386/an-accurate-nodejs-game-loop-inbetween-settimeout)
34. [DEV Community](https://dev.to/leapcell/high-precision-timing-in-nodejs-the-best-practices-3jh)
35. [@javelin/hrtime-loop - npm](https://www.npmjs.com/package/@javelin/hrtime-loop)
36. [Client-side prediction](https://en.wikipedia.org/wiki/Client-side_prediction)
37. [Latency Compensating Methods in Client/Server In-game ...](https://www.gamedevs.org/uploads/latency-compensation-in-client-server-protocols.pdf)
38. [Snapshot Interpolation](https://gafferongames.com/post/snapshot_interpolation/)
39. [Snapshot Compression](https://gafferongames.com/post/snapshot_compression/)
40. [gafferongames/content/post/snapshot\_interpolation.md at main · mas-bandwidth/gafferongames · GitHub](https://github.com/mas-bandwidth/gafferongames/blob/main/content/post/snapshot_interpolation.md)
41. [@geckos.io/snapshot-interpolation - npm Package Security Ana...](https://socket.dev/npm/package/@geckos.io/snapshot-interpolation)
42. [Determinism](https://rapier.rs/docs/user_guides/javascript/determinism/)
43. [Wacky Walk: 3D obstacle elimination show by jkdreamr · Pull Request #189 · jkdreamr/josh · GitHub](https://github.com/jkdreamr/josh/pull/189)
44. [gafferongames/content/post/state\_synchronization.md at master · mas-bandwidth/gafferongames · GitHub](https://github.com/mas-bandwidth/gafferongames/blob/master/content/post/state_synchronization.md)
45. [@colyseus/schema - npm](https://www.npmjs.com/package/@colyseus/schema?activeTab=readme)
46. [State Synchronization](https://gafferongames.com/post/state_synchronization/)
47. [GitHub - geckosio/geckos.io: 🦎 Real-time client/server communication over UDP using WebRTC and Node.js · GitHub](https://github.com/geckosio/geckos.io)
48. [WebTransport Explained: vs WebRTC, WHIP and MoQ in 2026](https://www.forasoft.com/learn/video-streaming/articles-streaming/webtransport-whip)
49. [Gaffer on Games](https://jaytaylor.com/notes/node/1456678774000.html)
50. [Netcode Fundamentals - Ping, Tick Rate, and Network Models Explained](https://edgegap.com/blog/netcode-fundamentals-ping-tick-rate-and-network-models-explained)
51. [Photon Fusion 2.1 Stable Adds Forecast Physics, Object Priority, and Reconnects](https://blog.photonengine.com/fusion-2-1-stable-release/)
52. [About Rapier](https://rapier.rs/docs/)
53. [Colyseus 0.16 is here!](https://colyseus.io/blog/colyseus-016-is-here/)
54. [Blog - Colyseus Multiplayer Framework](https://colyseus.io/blog/)
55. [geckos.io · GitHub](https://github.com/geckosio)
56. [WebTransport API - MDN Web Docs - Mozilla](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API)
57. [Socket.IO with WebTransport](https://socket.io/get-started/webtransport)
58. [Understanding Rocket League's Physics and Networking](https://coconote.app/notes/6dd350e7-4034-4a11-a829-cc5604249161)
59. [Game Maker's Notebook: Fall Guys with Mediatonic's Joe Walsh & Joel Herber](https://interactive.libsyn.com/fall-guys-with-mediatonics-joe-walsh-joel-herber)
