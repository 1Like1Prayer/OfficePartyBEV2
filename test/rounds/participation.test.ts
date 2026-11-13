/**
 * Players coming and going mid-round, early closing, progress relaying and
 * mid-round actions (Type Racer's dice).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SELF_TIMED } from '../../src/shared/constants.js';
import { crusherEscalatorModule } from '../../src/shared/games/crusherEscalator/module.js';
import { LOG_DODGE } from '../../src/shared/games/logDodge/constants.js';
import { logDodgeModule } from '../../src/shared/games/logDodge/module.js';
import { stopTheClockModule } from '../../src/shared/games/stopTheClock.js';
import { getSelfTimedModule } from '../../src/server/games/registry.js';
import { createRoundHarness } from '../support/roundHarness.js';

const noInputs = { inputs: [], timingSuspect: false };
const typeRacer = getSelfTimedModule('type-racer-roulette')!;
const typingProgress = (chars: number) => ({ chars, paragraph: 0, strikes: 0, skulls: 0, status: 0 });
const roll = { type: 'roll', rollIndex: 0 };

describe('early closing', () => {
    it('Log Dodge: once all but one have reported, the last is told to stop, once', () => {
        const h = createRoundHarness(logDodgeModule, 'log-dodge', ['a', 'b', 'c']);
        h.playAttempt();
        h.round.submitResult('a', 0, noInputs);
        assert.equal(h.closing.length, 0);
        h.round.submitResult('b', 0, noInputs);
        assert.equal(h.closing.length, 1);
        assert.deepEqual(h.closing[0]!.pending, ['c']);

        h.clock.advance(SELF_TIMED.CLOSING_GRACE_MS);
        assert.equal(h.resolved.length, 1);
        assert.deepEqual(h.resolved[0]!.noShow, ['c']);
    });

    it('a player leaving counts as gone: the one left is told to stop', () => {
        const h = createRoundHarness(logDodgeModule, 'log-dodge', ['a', 'b', 'c']);
        h.playAttempt();
        h.round.submitResult('a', 0, noInputs);
        h.round.dropParticipant('b');
        assert.deepEqual(h.closing[0]!.pending, ['c']);
    });

    it('Crusher Escalator final: the last one racing is told to stop', () => {
        const h = createRoundHarness(crusherEscalatorModule, 'crusher-escalator', ['a', 'b', 'c']);
        h.playAttempt();
        h.round.submitResult('a', 0, noInputs);
        assert.equal(h.closing.length, 0);
        h.round.submitResult('b', 0, noInputs);
        assert.deepEqual(h.closing[0]!.pending, ['c']);
    });

    it('games that do not end early never send a closing notice', () => {
        const h = createRoundHarness(stopTheClockModule, 'stop-the-clock', ['a', 'b', 'c']);
        h.playAttempt();
        h.round.submitResult('a', 0, { elapsedMs: 1000, timingSuspect: false });
        h.round.submitResult('b', 0, { elapsedMs: 1000, timingSuspect: false });
        assert.equal(h.closing.length, 0);
    });
});

describe('reconnecting mid-round', () => {
    it('a dropped player can rejoin: progress, dice and result all work again', () => {
        const h = createRoundHarness(typeRacer, 'type-racer-roulette', ['a', 'b', 'c']);
        h.playAttempt();
        h.round.dropParticipant('a');
        h.round.submitProgress('a', 0, typingProgress(5));
        assert.equal(h.progress.length, 0);
        assert.equal(h.round.handleAction('a', 0, roll).ok, false);

        assert.equal(h.round.rejoinParticipant('a'), true);
        h.round.submitProgress('a', 0, typingProgress(5));
        assert.equal(h.progress.length, 1);
        assert.equal(h.round.handleAction('a', 0, roll).ok, true);
        assert.equal(h.round.submitResult('a', 0, { events: [], endedAtMs: 0, timingSuspect: false }).ok, true);
    });

    it('only a player who dropped out of the running attempt can rejoin it', () => {
        const h = createRoundHarness(typeRacer, 'type-racer-roulette', ['a', 'b']);
        h.playAttempt();
        assert.equal(h.round.rejoinParticipant('stranger'), false);
        assert.equal(h.round.rejoinParticipant('a'), false, 'still in it');
    });
});

describe('progress', () => {
    it('an update inside the rate limit is held and delivered afterwards, not lost', () => {
        const h = createRoundHarness(typeRacer, 'type-racer-roulette', ['a', 'b']);
        h.playAttempt();
        h.round.submitProgress('a', 0, typingProgress(1));
        h.round.submitProgress('a', 0, typingProgress(2));
        h.round.submitProgress('a', 0, typingProgress(3));
        assert.equal(h.progress.length, 1);

        h.clock.advance(SELF_TIMED.PROGRESS_MIN_INTERVAL_MS);
        assert.equal(h.progress.length, 2);
        assert.equal(h.progress[1]!.progress['chars'], 3, 'the newest held update wins');
    });

    it('a held update is dropped if the player has left by then', () => {
        const h = createRoundHarness(typeRacer, 'type-racer-roulette', ['a', 'b']);
        h.playAttempt();
        h.round.submitProgress('a', 0, typingProgress(1));
        h.round.submitProgress('a', 0, typingProgress(2));
        h.round.dropParticipant('a');
        h.clock.advance(SELF_TIMED.PROGRESS_MIN_INTERVAL_MS);
        assert.equal(h.progress.length, 1);
    });

    it('a knock-out in a result is announced to the room even without progress messages', () => {
        const h = createRoundHarness(logDodgeModule, 'log-dodge', ['a', 'b']);
        h.playAttempt();
        h.round.submitResult('a', 0, noInputs);
        assert.deepEqual(h.progress.at(-1), { playerId: 'a', progress: { hits: LOG_DODGE.MAX_HITS } });
    });
});
