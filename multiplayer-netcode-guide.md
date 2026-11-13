# Multiplayer Netcode Guide (Fall Guys-style, Node + TypeScript)

Smooth multiplayer comes down to one rule: **each kind of object gets its own sync strategy.**

## Contents

1. [Fixed tick loop](#1-fixed-tick-loop)
2. [Clock sync](#2-clock-sync)
3. [Inputs and the server input buffer](#3-inputs-and-the-server-input-buffer)
4. [Prediction and reconciliation](#4-prediction-and-reconciliation)
5. [Interpolating other players](#5-interpolating-other-players)
6. [Deterministic obstacles](#6-deterministic-obstacles)
7. [Physics-driven props](#7-physics-driven-props)
8. [Transport and reliability](#8-transport-and-reliability)
9. [Bandwidth](#9-bandwidth)
10. [Player-vs-player collisions](#10-player-vs-player-collisions)
11. [Testing under bad networks](#11-testing-under-bad-networks)
12. [Suggested path](#suggested-path)
13. [Colyseus decision](#colyseus-decision)

## Quick reference: what to send, and how

| Thing | Strategy | Channel |
|---|---|---|
| Your own player | Send inputs, predict locally, reconcile | Unreliable (with redundancy) |
| Other players | Snapshots, interpolate ~100 ms in the past | Unreliable, latest wins |
| Deterministic obstacles | Spawn tick + parameters, compute `f(tick)` | Reliable, once |
| Pushable props | Server sim, send pos/vel/rot, interpolate | Unreliable |
| Eliminations, scores, round state | Events | Reliable, ordered |

---

## 1. Fixed tick loop

Simulate in fixed steps so every machine does identical maths. Node timers drift, so use an accumulator and catch up when behind.

```ts
const DT = 1 / 60, TICK_MS = 1000 / 60;
let acc = 0, last = performance.now(), tick = 0;

setInterval(() => {
  const now = performance.now();
  acc += now - last; last = now;
  while (acc >= TICK_MS) {
    step(tick, DT);                              // inputs, physics, rules
    if (tick % 3 === 0) broadcastSnapshot(tick); // 20 Hz
    tick++; acc -= TICK_MS;
  }
}, 4);
```

- Simulate at 30-60 Hz, send snapshots at 20-30 Hz. Rendering runs separately at display rate.
- Stamp every message with a **tick number**, not wall-clock time.
- Cap catch-up steps per wake so a stalled event loop drops backlog instead of spiralling.

**Tools:** Glenn Fiedler's "Fix Your Timestep" is the reference method. Colyseus wraps this as `setFixedTimestep`.

## 2. Clock sync

The client needs the server's current tick. Ping several times and trust the sample with the lowest round trip.

```ts
// client
send({ t: 'ping', c: performance.now() });

onPong(({ c, serverTick }) => {
  const rtt = performance.now() - c;
  const offset = serverTick + (rtt / 2) / TICK_MS - localTick();
  samples.push({ rtt, offset });
  samples.sort((a, b) => a.rtt - b.rtt);
  targetOffset = samples[0].offset;   // ease toward it, never jump
});
```

**Methodology:** Cristian's algorithm (the simple form of NTP). Re-sync every few seconds and smooth the estimate.

## 3. Inputs and the server input buffer

Clients send **intent, never position**. Resend the last few inputs so one lost packet costs nothing.

```ts
// client, once per tick
const input = { seq: ++seq, dx, dz, jump };
pending.push(input);
send({ t: 'in', inputs: pending.slice(-3) });

// server, on receive
for (const i of msg.inputs)
  if (i.seq > p.lastQueued) { p.queue.push(i); p.lastQueued = i.seq; }

// server, each tick: consume exactly one
const input = p.queue.shift() ?? p.lastInput;  // repeat if starved
p.state = stepPlayer(p.state, input, DT);
p.lastSeq = input.seq;
```

- Keep 1-2 inputs queued so jitter doesn't starve a tick.
- Validate everything and cap the queue so nobody can speed-hack by flooding.

## 4. Prediction and reconciliation

Put `stepPlayer` in a package shared by client and server. It must be a **pure function**: same state + same input = same result.

```ts
// client, on snapshot
const me = snap.players[myId];
const before = state.pos.clone();

state = structuredClone(me.state);                 // server truth
pending = pending.filter(i => i.seq > me.lastSeq); // drop acked
for (const i of pending) state = stepPlayer(state, i, DT); // replay

visualOffset.add(before.sub(state.pos)); // hide the correction
// render: mesh.position = state.pos + visualOffset; decay offset ~10%/frame
```

- Apply each input locally right away and keep it buffered.
- Each snapshot says "last input I processed was #N". Reset to server state, replay inputs after N.
- Blend the *visual mesh* toward the corrected position over ~100 ms instead of snapping.

**Tools:** Colyseus 0.18 has client-side prediction and lag compensation built in.

## 5. Interpolating other players

Buffer snapshots and render remote players roughly two snapshots in the past.

```ts
import { SnapshotInterpolation } from '@geckos.io/snapshot-interpolation';
const SI = new SnapshotInterpolation(20);   // server snapshot rate

socket.onmessage = m => SI.snapshot.add(decode(m.data));

// render loop
const snap = SI.calcInterpolation('x y z');
snap?.state.forEach(p => meshes[p.id].position.set(p.x, p.y, p.z));
```

- If a snapshot is late, extrapolate briefly (under ~250 ms), then freeze.

**Tools:** `@geckos.io/snapshot-interpolation` is a small library for exactly this (also called entity or buffer interpolation). It works with any transport and handles quaternions.

## 6. Deterministic obstacles

Send the **recipe once** and let everyone compute the position from the tick.

```ts
// server -> everyone, reliable, once
{ t: 'spawn', id: 7, spawnTick: 1200, start: [0, 1, -40], vel: [0, 0, 6] }

// shared code
const obstaclePos = (o, tick) =>
  o.start.map((s, i) => s + o.vel[i] * (tick - o.spawnTick) * DT);
```

- Send the spawn a second early (a future `spawnTick`) so it arrives before it starts.
- For random patterns send a **seed** and use a seeded generator (`seedrandom`, or a ten-line mulberry32), never `Math.random`.
- Evaluate obstacles at your **predicted** tick so they line up with your predicted player.
- Costs almost no bandwidth and stays perfectly smooth.

## 7. Physics-driven props

Things players can push can't be a formula. Simulate on the server and treat them like remote players.

```ts
import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = DT;

// each tick
world.step();
for (const b of props) {
  if (b.isSleeping()) continue;        // don't send resting bodies
  const t = b.translation(), r = b.rotation();
  writeProp(b.handle, t, r);
}
```

**Tools:** Rapier (Rust compiled to WASM) is the usual choice with Three.js. To predict physics on the client too:

- **Deterministic build:** `@dimforge/rapier3d-deterministic` trades some speed for a cross-platform determinism guarantee.
- **Rollback:** `world.createSnapshot()` gives you a world state to restore.
- **Caveat:** `Math.sin` / `Math.cos` can differ across platforms, so keep them out of initial conditions.

## 8. Transport and reliability

Split messages into two classes:

- **Unreliable, latest wins:** snapshots and inputs. A late one is useless, so never resend it.
- **Reliable, ordered:** spawns, eliminations, round state.

Options:

- **WebSocket** (`ws`, or `uWebSockets.js` for throughput): simplest, everything is reliable. TCP loss causes hitches, so start here and swap later.
- **geckos.io:** WebRTC data channels give a browser and a Node server a UDP link. You must open UDP ports on the host, which rules out platforms like Heroku.
- **WebTransport:** browser support is now complete (Chrome 97+, Firefox 114+, Safari 26.4+). The server side is the weak spot: Node has no native implementation, so you rely on a third-party package.

```ts
// one interface, so the transport is swappable
interface Net {
  sendUnreliable(b: ArrayBuffer): void;
  sendReliable(b: ArrayBuffer): void;
}
```

## 9. Bandwidth

Use binary, quantize, and skip what didn't change.

```ts
const v = new DataView(new ArrayBuffer(9));
v.setUint16(0, id);
v.setInt16(2, Math.round(x * 100));   // 1 cm steps, +-327 m
v.setInt16(4, Math.round(y * 100));
v.setInt16(6, Math.round(z * 100));
v.setUint8(8, Math.round((yaw / (2 * Math.PI)) * 255));
// 9 bytes, vs ~70 as JSON
```

**Tools:**

- `@colyseus/schema` does automatic delta sync.
- `@geckos.io/typed-array-buffer-schema` compresses snapshots before sending.
- `msgpackr` is the easy first step up from JSON.

## 10. Player-vs-player collisions

Locally you are in the present and everyone else is ~100 ms in the past, so hard collisions always disagree. Let the **server apply soft pushes**:

```ts
const d = a.pos.clone().sub(b.pos);
const overlap = 2 * RADIUS - d.length();
if (overlap > 0) {
  const push = d.normalize().multiplyScalar(overlap * STIFFNESS);
  a.vel.add(push); b.vel.sub(push);
}
```

- On the client, don't predict pushes from others. Let reconciliation (section 4) blend them in.
- Lag compensation (the server rewinds others to what you saw) matters for grabs and hits, not for bumping.

## 11. Testing under bad networks

Build a fake lag / jitter / loss toggle on day one. Test at 150 ms with 5% loss.

```ts
const LAG = 100, JITTER = 40, LOSS = 0.05;
const badSend = (send: (b: ArrayBuffer) => void, b: ArrayBuffer, unreliable: boolean) => {
  if (unreliable && Math.random() < LOSS) return;
  setTimeout(() => send(b), LAG + Math.random() * JITTER);
};
```

**Tools:** `tc netem` on Linux and Clumsy on Windows do this at OS level. Also draw **debug ghosts**: the server position as a wireframe next to your predicted mesh.

---

## Suggested path

Evaluate Colyseus 0.18 first, since it covers sections 1, 3, 4, 8 and 9. Add the geckos interpolation library and Rapier, and hand-write only the obstacle functions and collision rules.

## Colyseus decision

Reviewed source at the Nov 10, 2026 commit (core 0.18.28). Test suite was not run.

**Verdict: use Colyseus, but couple to it thinly.**

**Why not rebuild with AI**

- The client prediction library is ~6,800 lines; server input + rewind code ~2,100; ~3,600 lines of tests target prediction alone.
- AI can write the happy path quickly. The cost is in bugs you only find under real networks.
- It already covers fixed-step loop, input buffering with clamping, reconciliation, interpolation, clock sync, lag compensation, and a latency simulator.

**What the code looks like**

- Tick loop is a clean accumulator, capped at 5 catch-up steps, and advertises the tick rate to clients so both sides use the same `dt`.
- You supply one shared `step(ctx, state, input)` function, which is the right boundary.
- A drift readout tells you whether rubber-banding is a determinism bug or network jitter.
- `room.clock.serverNow()` supports the `position = f(serverNow)` obstacle pattern.

**Risks**

- **Experimental APIs:** prediction, input and rewind are labelled experimental. 0.18.1 changed the wire format and renamed core APIs; core has shipped 28 patch releases since August.
- **WebTransport:** the transport is experimental and depends on a native QUIC library. On WebSocket, "unreliable" traffic falls back to the reliable channel, so no real UDP behaviour yet.
- **Tick coupling:** input rate equals tick rate; sub-stepping is the only escape.
- **Physics rollback:** restores positions and velocities, not engine internals (contact caches, etc.). Fine for dodging, weaker for heavy stacking.
- **Maintainer:** every package lists the same single author (contributor stats could not be confirmed).
- **Lock-in:** state must be `@colyseus/schema` classes and the client must use their SDK.

**How to couple safely**

1. Keep the simulation in a plain TypeScript package with no Colyseus imports (`stepPlayer`, obstacle functions, collision rules).
2. Make the Room a thin adapter that drains inputs, calls your step, and copies results into schema state.
3. Pin exact versions of `@colyseus/core`, `sdk` and `schema`, and upgrade them together.
4. Start on WebSocket; revisit WebTransport when it leaves experimental.

---

## References

- Gabriel Gambetta, "Fast-Paced Multiplayer" series
- Glenn Fiedler, Gaffer on Games ("Fix Your Timestep")
- Valve, "Source Multiplayer Networking"
- [Colyseus docs](https://docs.colyseus.io/)
- [@geckos.io/snapshot-interpolation](https://www.npmjs.com/package/@geckos.io/snapshot-interpolation)
- [Rapier JS determinism](https://rapier.rs/docs/user_guides/javascript/determinism)
