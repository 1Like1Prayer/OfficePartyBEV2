/**
 * Hex Drop through the round runner: the shared world its touches write,
 * the faster progress rate, and the round ending with the last runner up.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HEX_DROP } from '../../src/shared/games/hexDrop/constants.js';
import { hexDropModule } from '../../src/shared/games/hexDrop/module.js';
import { createRoundHarness } from '../support/roundHarness.js';

const touch = (tile: number, atMs: number) => ({ type: 'touch', tile, atMs });
const position = (t: number) => ({ t, x: 0, y: 2_100, z: 0, out: 0 });

describe('shared world (Hex Drop)', () => {
    it('a touch is timed on the round clock and published to everyone', () => {
        const h = createRoundHarness(hexDropModule, 'hex-drop', ['a', 'b']);
        h.playAttempt();
        h.clock.advance(2_000);

        const reply = h.round.handleAction('a', 0, touch(3, 1_950));
        assert.deepEqual(reply, { ok: true, value: { tile: 3, fallAtMs: 1_950 + HEX_DROP.FALL_DELAY_MS } });
        assert.deepEqual(h.shared, { 3: 1_950 + HEX_DROP.FALL_DELAY_MS });

        // A later touch by someone else does not push it back.
        h.round.handleAction('b', 0, touch(3, 1_990));
        assert.deepEqual(h.shared, { 3: 1_950 + HEX_DROP.FALL_DELAY_MS });
    });

    it('touches are refused outside play, and the world starts empty each attempt', () => {
        const h = createRoundHarness(hexDropModule, 'hex-drop', ['a', 'b']);
        assert.equal(h.round.handleAction('a', 0, touch(3, 0)).ok, false, 'not before the start');
        h.playAttempt();
        h.round.handleAction('a', 0, touch(3, 0));
        // Both fall out on the same millisecond: a tie, so a tiebreaker attempt follows.
        h.round.submitResult('a', 0, { outAtMs: 4_000 });
        h.round.submitResult('b', 0, { outAtMs: 4_000 });
        h.clock.advance(10_000);
        assert.equal(h.round.describe().attempt, 1);
        assert.deepEqual(h.shared, {});
    });

    it('positions are relayed about 20 times a second, not 5', () => {
        const h = createRoundHarness(hexDropModule, 'hex-drop', ['a', 'b']);
        h.playAttempt();
        for (let step = 0; step < 20; step++) {
            h.round.submitProgress('a', 0, position(step * 50));
            h.clock.advance(50);
        }
        assert.ok(h.progress.length >= 19, `${h.progress.length} relayed`);
    });

    it('once all but one have fallen out, the last runner is told to stop, and wins', () => {
        const h = createRoundHarness(hexDropModule, 'hex-drop', ['a', 'b', 'c']);
        h.playAttempt();
        h.round.submitResult('a', 0, { outAtMs: 5_000 });
        assert.equal(h.closing.length, 0);
        h.round.submitResult('b', 0, { outAtMs: 9_000 });
        assert.deepEqual(h.closing[0]!.pending, ['c']);
        h.round.submitResult('c', 0, { outAtMs: null });
        assert.equal(h.resolved[0]!.winnerId, 'c');
        assert.deepEqual(h.resolved[0]!.ranked.map(({ playerId }) => playerId), ['c', 'b', 'a']);
    });
});
