# Office Party V2

The Colyseus server for Office Party. After choosing a name and avatar,
players pick one of two sections:

- **Mini games**: the party competition, eight minigames played in rounds
  (Minefield, Cube Counter, Crusher Escalator, Stop the Clock, Type Racer
  Roulette, Log Dodge, Hex Drop and Mage Battle). Room name `party`.
- **Standalone games**: one game played on its own, in its own room. The
  list is `STANDALONE_CATALOG` (`src/shared/standalone/catalog.ts`); the
  first is **Skribbl**. Room name `skribbl`.

Both kinds of room are joined the same way: create one, share its
4-character code, others join by code.

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
| `npm run bots -- --room ABCD --count 11` | Bots join a room and play every game (see below) |
| `npm run bots:skribbl -- --room ABCD --count 5` | Bots join a Skribbl room, draw and guess |

## File tree

```
src/
  index.ts, app.config.ts      Colyseus entry and room registration
  shared/                      Imported by browser and server. No Colyseus, no I/O.
    protocol.ts                Message names, payloads, reply and error types
    constants.ts               Platform tunables (players, timings, clock sync)
    clockSync.ts               Client-side server-clock estimate
    games/                     One folder per game: rules as plain functions
    standalone/                The standalone catalogue, and one folder per game
      skribbl/                 Protocol, state types, guess matching, hints,
                               scoring, the binary drawing format + canvas model
  server/
    platform/                  Scheduler (room timeline + timers), identity, Outcome,
                               Members (shared by every room), PlayerState
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
    rooms/skribbl/             The Skribbl room: thin adapter, lobby (settings),
                               game (turns, word, guesses, drawing), schema, messages
    standalone/skribbl/        Server-only: word list (edit words.ts), blocklist, word picker
test/                          Runner, match flow and real-server tests (+ support/)
loadtest/                      partyRoom.ts (@colyseus/loadtest), partyBots.ts (playing bots)
```

## Playing with bots

To try a full room by yourself:

1. Run the server (`npm start`) and the web app (`npm run dev` in the client repo).
2. Host a room at http://localhost:5173 and note its 4-letter code.
3. Fill the room with bots:

   ```sh
   npm run bots -- --room ABCD --count 11
   ```

The bots join, ready up one by one and play every game, some well and some
badly, sending the same live progress and results a real player does.
Ctrl+C stops them.

| Option | Default | What it does |
|---|---|---|
| `--room CODE` | (required) | Room to join |
| `--count N` | `11` | How many bots join |
| `--endpoint URL` | `http://localhost:2567` | Game server to connect to |
| `--flaky` | off | Some bots drop their connection mid-round and come back |

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

## Skribbl client contract

Everything the party contract says about joining, protocol version, requests,
clock sync and reconnecting holds here too, with `SKRIBBL_ROOM_NAME`. Names
and types are in `src/shared/standalone/skribbl/protocol.ts`; the synced
state's shape is `SkribblStateJson` (`state.ts`).

- **Lobby:** the owner sets `rounds`, `drawTimeSec`, `wordChoices` and `hints`
  (`SkribblRequest.UpdateSettings`, clamped to `SKRIBBL_SETTINGS`) and starts
  once `state.canStart`. There is no ready check.
- **A turn:** `state.turn` goes `choosing` -> `drawing` -> `reveal`, with
  `endsAtMs` on the room timeline. Every player draws once per round.
  - The drawer gets `WordChoices` privately and answers with `ChooseWord`
    (one is picked for them after `CHOOSE_MS`).
  - The word is **never** in state. The drawer, and each guesser once they
    get it, receive it in a private `Word` message. Everyone else sees
    `turn.wordPattern` (`_` per hidden letter), which gains letters as hints.
  - `TurnEnded` reveals the word and the turn's points; `GameEnded` the podium.
- **Chat and guesses:** send every line with `SkribblRequest.Say`. While
  someone draws, a guesser's line is their guess: the reply's `verdict` is
  `correct` (never shown to others), `close` (show "close!" to this player
  only) or `sent`. The drawer and players who guessed share a `guessed`
  channel, and are refused (`reveals_word`) if they type the word.
- **Drawing:** the drawer batches its ops about 20 times a second into one
  packet (`encodeDrawPacket`, with `turn.turnId`) and sends it with
  `room.sendBytes(SkribblBytes.Draw, bytes)`. Others receive the same bytes
  under `SkribblBytes.Draw`, and should replay them about 100 ms late, at the
  drawn pace (`dtMs`). Draw on a fixed `CANVAS.WIDTH x CANVAS.HEIGHT` bitmap and
  scale it, so a fill covers the same pixels everywhere. Keep a `CanvasModel`
  to redraw after an undo. Match packets to a turn by `turnId`, not by phase.
- **Joining mid-game:** newcomers play at once as guessers, and draw from the
  next round. On joining or reconnecting mid-turn, a client receives
  `SkribblBytes.Canvas` (the whole drawing, shown at once) and any private
  message it missed. A drawer who drops gets `DRAWER_GRACE_MS` to come back.
