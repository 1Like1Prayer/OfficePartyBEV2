/**
 * Further attempts inside one scoring round: tiebreakers, the coin flip once
 * they are exhausted, and staged games (heats -> final).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SELF_TIMED } from '../../src/shared/constants.js';
import type { AttemptTiming, RankedEntry, RoundContext } from '../../src/shared/games/selfTimed.js';
import { stopTheClockModule, type StopTheClockRound } from '../../src/shared/games/stopTheClock.js';
import type { AnySelfTimedModule } from '../../src/server/games/registry.js';
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
    const players = ['p1', 'p2', 'p3', 'p4'];
    const OPENING: AttemptTiming = { startLeadMs: 1_000, countdownMs: 9_000 };
    const FINAL: AttemptTiming = { startLeadMs: 2_000, countdownMs: 3_000 };
    const PAUSE_MS = 3_000;

    /**
     * No built game has stages today, so this one is made up for the test:
     * Stop the Clock, where the opening attempt is a heat whose best two go
     * on to a final with a shorter run-up.
     */
    const staged: AnySelfTimedModule = {
        ...stopTheClockModule,
        createRoundData: (context: RoundContext) => ({
            ...stopTheClockModule.createRoundData(context),
            heat: context.attempt === 0
        }),
        openingTiming: () => OPENING,
        nextStage: (ranked: RankedEntry[], round: { heat: boolean }) =>
            round.heat
                ? { participants: ranked.slice(0, 2).map((row) => row.playerId), pauseMs: PAUSE_MS, timing: FINAL }
                : null
    };

    it('a heat, a pause, then a final among the qualifiers with its own run-up', () => {
        const h = createRoundHarness(staged, 'stop-the-clock', players);
        assert.equal(h.round.describe().countdownMs, OPENING.countdownMs, 'the opening uses the game\'s timing');
        h.playAttempt();
        const target = (h.roundData.at(-1)!.data as StopTheClockRound).targetMs;
        players.forEach((id, i) => h.round.submitResult(id, 0, { elapsedMs: target + i * 100, timingSuspect: false }));

        const heat = h.resolved[0]!;
        assert.equal(heat.isFinal, false);
        assert.deepEqual(heat.advancing, ['p1', 'p2']);
        assert.equal(heat.stageBreakMs, PAUSE_MS);

        h.clock.advance(PAUSE_MS);
        const final = h.round.describe();
        assert.equal(final.attempt, 1);
        assert.equal(final.isTiebreak, false);
        assert.deepEqual(final.participants, ['p1', 'p2']);
        for (const id of final.participants) h.round.markReady(id, 1);
        assert.equal(h.round.describe().countdownMs, FINAL.countdownMs);
        assert.equal(h.round.describe().startAtMs! - h.clock.now(), FINAL.startLeadMs);
    });
});
