/**
 * The browser types the Skribbl state with `SkribblStateJson` (shared/);
 * the server defines it with schema classes. This keeps the two in step,
 * like test/partyStateShape.test.ts does for the party room.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SkribblSettings } from '../../src/shared/standalone/skribbl/protocol.js';
import type { SkribblStateJson, TurnStateJson } from '../../src/shared/standalone/skribbl/state.js';
import { SkribblState } from '../../src/server/rooms/skribbl/schema/SkribblState.js';

type KeyList<T> = Record<keyof T, true>;

const STATE_KEYS: KeyList<SkribblStateJson> = {
    roomCode: true, phase: true, ownerId: true, players: true, settings: true,
    canStart: true, blockedReason: true, minPlayers: true, maxPlayers: true, turn: true
};
const SETTINGS_KEYS: KeyList<SkribblSettings> = { rounds: true, drawTimeSec: true, wordChoices: true, hints: true };
const TURN_KEYS: KeyList<TurnStateJson> = {
    phase: true, turnId: true, round: true, totalRounds: true, drawerId: true,
    endsAtMs: true, drawTimeMs: true, wordPattern: true, guessed: true
};

const sortedKeys = (value: object): string[] => Object.keys(value).sort();

describe('skribbl synced state shape', () => {
    it('the schema serialises to exactly the shared JSON type', () => {
        const state = new SkribblState();
        state.roomCode = 'ABCD';
        const json = state.toJSON() as unknown as SkribblStateJson;
        assert.deepEqual(sortedKeys(json), sortedKeys(STATE_KEYS));
        assert.deepEqual(sortedKeys(json.settings), sortedKeys(SETTINGS_KEYS));
        assert.deepEqual(sortedKeys(json.turn), sortedKeys(TURN_KEYS));
    });
});
