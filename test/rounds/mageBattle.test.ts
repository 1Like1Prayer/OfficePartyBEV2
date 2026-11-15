/**
 * Mage Battle through the round runner: presses scored into the shared world,
 * a knock-out closing the round at once, and the ranking read from the world.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { advanceTo, blocksOf, speedOf, spinEndsAtMs } from '../../src/shared/games/mageBattle/dial.js';
import { dialKey, mageBattleModule, readDial } from '../../src/shared/games/mageBattle/module.js';
import type { MageBattleRound } from '../../src/shared/games/mageBattle/types.js';
import { createRoundHarness, type RoundHarness } from '../support/roundHarness.js';

const roundOf = (h: RoundHarness) => h.roundData.at(-1)!.data as MageBattleRound;

/** Presses `playerId`'s dial on the smallest block, moving the clock to that moment. */
const hitSmallest = (h: RoundHarness, playerId: string, raceStartMs: number) => {
    const round = roundOf(h);
    const stored = readDial({ get: (key) => h.shared[key] }, round, playerId);
    const dial = stored.pressPoints === null ? stored : advanceTo(stored, spinEndsAtMs(stored), round.seed, playerId);
    const block = blocksOf(dial.level).at(-1)!;
    const atMs = Math.ceil(dial.sinceMs + ((dial.zone + (block.fromDeg + block.toDeg) / 2) / speedOf(dial.level)) * 1000);
    h.clock.advance(Math.max(0, raceStartMs + atMs - h.clock.now()));
    return h.round.handleAction(playerId, 0, { type: 'press', atMs });
};

describe('Mage Battle', () => {
    it('knocking out the last opponent ends the round, and the survivor wins', () => {
        const h = createRoundHarness(mageBattleModule, 'mage-battle', ['a', 'b']);
        h.playAttempt();
        const raceStartMs = h.clock.now();

        assert.deepEqual(hitSmallest(h, 'a', raceStartMs), {
            ok: true,
            value: { counted: true, points: 4, dial: readDial({ get: (key) => h.shared[key] }, roundOf(h), 'a'), eliminated: [] }
        });
        assert.equal(h.closing.length, 0);
        hitSmallest(h, 'a', raceStartMs);
        assert.equal(h.shared[dialKey('b', 'outAtMs')] !== undefined, true, 'b is 8 behind');
        assert.deepEqual(h.closing[0]!.pending.sort(), ['a', 'b'], 'everyone told to stop at once');

        h.round.submitResult('b', 0, {});
        h.round.submitResult('a', 0, {});
        assert.equal(h.resolved[0]!.winnerId, 'a');
        assert.equal(h.resolved[0]!.ranked[0]!.detail.score, 8);
    });

    it('after the clock runs out, the highest score wins', () => {
        const h = createRoundHarness(mageBattleModule, 'mage-battle', ['a', 'b']);
        h.playAttempt();
        hitSmallest(h, 'b', h.clock.now());
        h.round.submitResult('a', 0, {});
        h.round.submitResult('b', 0, {});
        assert.equal(h.resolved[0]!.winnerId, 'b');
    });
});
