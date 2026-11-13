/**
 * Further attempts inside one scoring round: tiebreakers, the coin flip once
 * they are exhausted, and staged games (Crusher Escalator heats -> final).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SELF_TIMED } from '../../src/shared/constants.js';
import { CRUSHER_ESCALATOR } from '../../src/shared/games/crusherEscalator/constants.js';
import { crusherEscalatorModule } from '../../src/shared/games/crusherEscalator/module.js';
import { stopTheClockModule, type StopTheClockRound } from '../../src/shared/games/stopTheClock.js';
import { decideAttemptOutcome } from '../../src/server/rounds/attemptOutcome.js';
import { createRoundHarness, type RoundHarness } from '../support/roundHarness.js';

const reportExactly = (h: RoundHarness, players: readonly string[]) => {
    const { attempt } = h.round.describe();
    const target = (h.roundData.at(-1)!.data as StopTheClockRound).targetMs;
    for (const id of players) {
        h.round.submitResult(id, attempt, { elapsedMs: target, timingSuspect: false });
    }
};

describe('tiebreakers', () => {
    it('an exact tie runs a fresh attempt among just the tied players', () => {
        const h = createRoundHarness(stopTheClockModule, 'stop-the-clock', ['a', 'b', 'c']);
        h.playAttempt();
        reportExactly(h, ['a', 'b']);
        h.round.submitResult('c', 0, { elapsedMs: 0, timingSuspect: false });

        assert.equal(h.resolved[0]!.isFinal, false);
        h.clock.advance(SELF_TIMED.TIEBREAK_DELAY_MS);
        const view = h.round.describe();
        assert.equal(view.attempt, 1);
        assert.equal(view.isTiebreak, true);
        assert.deepEqual(view.participants, ['a', 'b']);
        assert.equal(h.roundData.length, 2, 'the tiebreaker gets fresh round data');
    });

    it('after the last tiebreaker a surviving tie is drawn, and says so', () => {
        const h = createRoundHarness(stopTheClockModule, 'stop-the-clock', ['a', 'b']);
        for (let attempt = 0; attempt < SELF_TIMED.MAX_TIEBREAK_ATTEMPTS; attempt++) {
            if (attempt > 0) h.clock.advance(SELF_TIMED.TIEBREAK_DELAY_MS);
            h.playAttempt();
            reportExactly(h, ['a', 'b']);
        }
        const final = h.resolved.at(-1)!;
        assert.equal(final.isFinal, true);
        assert.equal(final.decidedByCoinFlip, true);
        assert.ok(['a', 'b'].includes(final.winnerId!));
    });

    it('decideAttemptOutcome checks a stage before a tie', () => {
        const tied = [
            { playerId: 'a', rank: 1, reported: true, detail: {} },
            { playerId: 'b', rank: 1, reported: true, detail: {} }
        ];
        const stage = { participants: ['a', 'b'], pauseMs: 10 };
        assert.equal(decideAttemptOutcome(tied, stage, 0).kind, 'next-stage');
        assert.equal(decideAttemptOutcome(tied, null, 0).kind, 'tiebreak');
    });
});

describe('stages', () => {
    const players = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];

    it('8 players: heats, a pause, then a 6-player final with a shorter run-up', () => {
        const h = createRoundHarness(crusherEscalatorModule, 'crusher-escalator', players);
        assert.equal(
            h.round.describe().countdownMs,
            SELF_TIMED.COUNTDOWN_MS + CRUSHER_ESCALATOR.HEATS_EXTRA_ANIMATION_MS,
            'heats open with extra time for the sorting animation'
        );
        h.playAttempt();
        // Nobody pressed anything: two crushed players end the heats.
        for (const id of players) h.round.submitResult(id, 0, { inputs: [], timingSuspect: false });

        const heats = h.resolved[0]!;
        assert.equal(heats.isFinal, false);
        assert.ok(heats.advancing !== null && heats.advancing.length >= CRUSHER_ESCALATOR.FINALISTS);
        assert.equal(heats.stageBreakMs, CRUSHER_ESCALATOR.FINAL_PAUSE_MS);

        h.clock.advance(CRUSHER_ESCALATOR.FINAL_PAUSE_MS);
        const final = h.round.describe();
        assert.equal(final.attempt, 1);
        assert.equal(final.isTiebreak, false);
        assert.deepEqual([...final.participants].sort(), [...heats.advancing!].sort());
        for (const id of final.participants) h.round.markReady(id, 1);
        assert.equal(final.countdownMs, CRUSHER_ESCALATOR.FINAL_COUNTDOWN_MS);
        assert.equal(h.round.describe().startAtMs! - h.clock.now(), CRUSHER_ESCALATOR.FINAL_START_LEAD_MS);
    });
});
