# Office Party V2

The Colyseus server for eight office-party minigames: Minefield, Cube Counter,
Crusher Escalator, Stop the Clock, Type Racer Roulette, Log Dodge, Hex Drop
and Mage Battle.

Six are **self-timed**: each browser plays the round on its own clock and
reports what happened, and the server replays the reports to decide the
winner. Latency can't change who wins, and no shared-world netcode
(prediction, interpolation) is needed.

Hex Drop is played in one **shared world**: each browser moves its own runner,
the server owns the tiles (when each one drops), and the other runners are
drawn from positions shared 20 times a second. It runs on the same round
runner. See `src/server/games/registry.ts`.

Mage Battle is a free-for-all of quick-time duels. Each browser turns its own
dial and sends the time of each press. The server replays that dial to decide
what the press scored, and keeps every dial and score in the shared world, so
each screen can draw everyone's duel. Fall 7 points behind the leader and
you're out. The last mage standing wins, or the highest score after 60 seconds.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Dev server with watch, on :2567 (`/monitor`, playground at `/`) |
| `npm test` | All tests (node:test): game rules, round runner, match flow, real-server room |
| `npm run typecheck` | Strict type check of src, tests and loadtest |
| `npm run build` | Compile to `build/` |
| `npm run loadtest -- --roomId ABCD --numClients 11` | Bots join a room, sync clocks, press ready |

## File tree

```
src/
  index.ts, app.config.ts      Colyseus entry and room registration
  shared/                      Imported by browser and server. No Colyseus, no I/O.
    protocol.ts                Message names, payloads, reply and error types
    constants.ts               Platform tunables (players, timings, clock sync)
    clockSync.ts               Client-side server-clock estimate
    games/                     One folder per game: rules as plain functions
  server/
    platform/                  Scheduler (room timeline + timers), identity, Outcome
    games/                     Registry of playable games; server-only dice secret
    competition/               Playlist building and the score table
    rounds/                    The self-timed round runner (framework-free)
    rooms/party/               The Colyseus room
      PartyRoom.ts             Thin adapter: lifecycle hooks -> controllers
      members.ts, lobby.ts,    Controllers: membership/owner, lobby rules,
      matchFlow.ts             the competition and the current round
      roundSync.ts             Runner output -> schema state
      schema/                  Synced state (players, lobby, round, progress)
      messages/                Zod validators and the request handlers
test/                          Runner, match flow and real-server tests (+ support/)
loadtest/                      @colyseus/loadtest script
```

## Client contract

- **Join:** `client.create('party', { protocolVersion, name, avatar })`. Others
  join with `client.joinById(code, …)`. The 4-character room code is the
  Colyseus `roomId`. An outdated client is refused with close code `4100`
  (`PROTOCOL_MISMATCH_CODE`) and should reload.
- **State** (delta-synced): render from `room.state`. It holds players,
  owner, lobby start rules, playlist, points, round lifecycle and live
  progress. Server times are on the room timeline.
- **Messages** (`room.onMessage`): `ServerMessage.*` covers round data, game
  starting, round closing, results and leaderboard.
- **Requests** (`await room.request(ClientRequest.X, payload)`): a refusal
  rejects with an Error whose `reason` is `{ code, message }`.
- **Progress:** `room.send(ClientMessage.Progress, …)` at ~5 Hz, display only.
- **Clock sync:** ping with `ClientRequest.Ping` on the `nextPingDelayMs`
  cadence, feed replies into `ClockSync`, and convert scheduled server times
  with `clock.toLocalTime(...)`.
- **Reconnect:** keep `room.reconnectionToken`. The SDK reconnects
  automatically for 30 s; after a reload use `client.reconnect(token)`. The
  state resyncs and the current round data is sent again.
