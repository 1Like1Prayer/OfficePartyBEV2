/**
 * The browser types the synced state with `PartyStateJson` (shared/), while
 * the server defines it with schema classes. This keeps the two in step.
 *
 * Each key list is a `Record<keyof T, true>`, so the compiler insists it names
 * every field of the shared type and nothing else; the test then checks the
 * schema's real `toJSON()` output has exactly those fields.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
    LobbyStateJson,
    PartyStateJson,
    PlayerStateJson,
    RoundStateJson
} from '../src/shared/partyState.js';
import { PartyState } from '../src/server/rooms/party/schema/PartyState.js';
import { PlayerState } from '../src/server/rooms/party/schema/PlayerState.js';
import { ProgressState } from '../src/server/rooms/party/schema/RoundState.js';

type KeyList<T> = Record<keyof T, true>;

const PARTY_KEYS: KeyList<PartyStateJson> = {
    roomCode: true, phase: true, ownerId: true, players: true, lobby: true,
    playlist: true, totalRounds: true, round: true, minPlayers: true, maxPlayers: true
};
const PLAYER_KEYS: KeyList<PlayerStateJson> = {
    id: true, name: true, avatar: true, connected: true, isOwner: true,
    isSpectator: true, ready: true, points: true, joinOrder: true
};
const LOBBY_KEYS: KeyList<LobbyStateJson> = {
    mode: true, customPlaylist: true, playableGames: true, roundsByGame: true,
    waitingFor: true, canStart: true, blockedReason: true
};
const ROUND_KEYS: KeyList<RoundStateJson> = {
    phase: true, roundId: true, attempt: true, gameId: true, gameIndex: true,
    totalGames: true, roundInGame: true, roundsPerGame: true, isTiebreak: true,
    participants: true, ready: true, waitingFor: true, readyDeadlineMs: true,
    startAtMs: true, countdownMs: true, timingStartsAtMs: true, resultTimeoutMs: true,
    progress: true, shared: true
};

const sortedKeys = (value: object): string[] => Object.keys(value).sort();

describe('synced state shape', () => {
    it('the schema serialises to exactly the shared JSON type', () => {
        const state = new PartyState();
        // Fill the optional fields, so they appear in the output.
        state.roomCode = 'ABCD';
        state.round.startAtMs = 1;
        state.round.timingStartsAtMs = 2;
        state.players.set('p', new PlayerState({ id: 'p', name: 'P', avatar: 'p' }));
        const progress = new ProgressState();
        progress.values.set('x', 1);
        state.round.progress.set('p', progress);

        const json = state.toJSON() as unknown as PartyStateJson;
        assert.deepEqual(sortedKeys(json), sortedKeys(PARTY_KEYS));
        assert.deepEqual(sortedKeys(json.players['p']!), sortedKeys(PLAYER_KEYS));
        assert.deepEqual(sortedKeys(json.lobby), sortedKeys(LOBBY_KEYS));
        assert.deepEqual(sortedKeys(json.round), sortedKeys(ROUND_KEYS));
        assert.deepEqual(json.round.progress, { p: { values: { x: 1 } } });
    });
});
