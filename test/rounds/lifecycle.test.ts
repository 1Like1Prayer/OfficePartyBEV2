/**
 * The round runner's lifecycle: ready check, scheduled start, collection,
 * timeouts, and the bookkeeping rules (stale, duplicate, wrong phase).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SELF_TIMED } from '../../src/shared/constants.js';
import { stopTheClockModule, type StopTheClockRound } from '../../src/shared/games/stopTheClock.js';
import { createRoundHarness } from '../support/roundHarness.js';

const stopAt = (elapsedMs: number) => ({ elapsedMs, timingSuspect: false });
const targetOf = (data: unknown) => (data as StopTheClockRound).targetMs;

describe('self-timed round lifecycle', () => {
    it('loads, waits for everyone, then schedules the start a lead time out', () => {
        const h = createRoundHarness(stopTheClockModule, 'stop-the-clock', ['a', 'b']);
        assert.equal(h.roundData.length, 1);
        assert.equal(h.round.describe().phase, 'ready-check');

        assert.equal(h.round.markReady('a', 0).ok, true);
        assert.equal(h.round.describe().phase, 'ready-check');
        assert.deepEqual(h.round.describe().waitingFor, ['b']);

        h.round.markReady('b', 0);
        const view = h.round.describe();
        assert.equal(view.phase, 'starting');
        assert.equal(view.startAtMs, SELF_TIMED.START_LEAD_MS);
        assert.equal(view.timingStartsAtMs, SELF_TIMED.START_LEAD_MS + SELF_TIMED.COUNTDOWN_MS);
    });

    it('refuses results until the clock runs, then accepts the first report per player only', () => {
        const h = createRoundHarness(stopTheClockModule, 'stop-the-clock', ['a', 'b']);
        h.round.markReady('a', 0);
        h.round.markReady('b', 0);
        assert.equal(h.round.submitResult('a', 0, stopAt(1000)).ok, false, 'not during the lead');

        h.clock.advance(SELF_TIMED.START_LEAD_MS);
        assert.equal(h.round.describe().phase, 'countdown');
        assert.equal(h.round.submitResult('a', 0, stopAt(1000)).ok, false, 'not during the countdown');

        h.clock.advance(SELF_TIMED.COUNTDOWN_MS);
        assert.equal(h.round.submitResult('a', 0, stopAt(1000)).ok, true);
        const duplicate = h.round.submitResult('a', 0, stopAt(2000));
        assert.equal(!duplicate.ok && duplicate.error.code, 'duplicate_result');
    });

    it('refuses messages for a past attempt and from non-participants', () => {
        const h = createRoundHarness(stopTheClockModule, 'stop-the-clock', ['a', 'b']);
        const stale = h.round.markReady('a', 1);
        assert.equal(!stale.ok && stale.error.code, 'stale_round');
        const outsider = h.round.markReady('zed', 0);
        assert.equal(!outsider.ok && outsider.error.code, 'not_in_room');
    });

    it('a player can take back their ready during the ready check', () => {
        const h = createRoundHarness(stopTheClockModule, 'stop-the-clock', ['a', 'b']);
        h.round.markReady('a', 0);
        assert.equal(h.round.markReady('a', 0, false).ok, true);
        assert.deepEqual(h.round.describe().waitingFor, ['a', 'b']);

        // Ready again, then b: the start is scheduled as usual.
        h.round.markReady('a', 0);
        h.round.markReady('b', 0);
        assert.equal(h.round.describe().phase, 'starting');
    });

    it('taking back a ready during the lead calls the start off until they are ready again', () => {
        const h = createRoundHarness(stopTheClockModule, 'stop-the-clock', ['a', 'b']);
        h.round.markReady('a', 0);
        h.round.markReady('b', 0);
        h.clock.advance(SELF_TIMED.START_LEAD_MS - 1000);

        assert.equal(h.round.markReady('b', 0, false).ok, true);
        const view = h.round.describe();
        assert.equal(view.phase, 'ready-check');
        assert.equal(view.startAtMs, null);
        assert.deepEqual(view.waitingFor, ['b']);

        // The old start time passes and nothing starts.
        h.clock.advance(2000);
        assert.equal(h.round.describe().phase, 'ready-check');

        h.round.markReady('b', 0);
        assert.equal(h.round.describe().phase, 'starting');
        assert.equal(h.round.describe().startAtMs, h.clock.now() + SELF_TIMED.START_LEAD_MS);
    });

    it('someone who backs out late still gets a grace period before the ready check gives up on them', () => {
        const h = createRoundHarness(stopTheClockModule, 'stop-the-clock', ['a', 'b']);
        h.round.markReady('a', 0);
        h.clock.advance(SELF_TIMED.READY_CHECK_TIMEOUT_MS - 500);
        h.round.markReady('b', 0);
        h.round.markReady('b', 0, false);

        h.clock.advance(SELF_TIMED.UNREADY_GRACE_MS - 1);
        assert.equal(h.round.describe().phase, 'ready-check');
        h.clock.advance(1);
        assert.equal(h.round.describe().phase, 'starting');
        assert.deepEqual(h.round.describe().participants, ['a']);
    });

    it('a ready can no longer be taken back once the countdown is under way', () => {
        const h = createRoundHarness(stopTheClockModule, 'stop-the-clock', ['a', 'b']);
        h.round.markReady('a', 0);
        h.round.markReady('b', 0);
        h.clock.advance(SELF_TIMED.START_LEAD_MS);
        const late = h.round.markReady('a', 0, false);
        assert.equal(!late.ok && late.error.code, 'wrong_phase');
        assert.equal(h.round.describe().phase, 'countdown');
    });

        it('a ready-check timeout starts without the stragglers', () => {
        const h = createRoundHarness(stopTheClockModule, 'stop-the-clock', ['a', 'b']);
        h.round.markReady('a', 0);
        h.clock.advance(SELF_TIMED.READY_CHECK_TIMEOUT_MS);
        assert.equal(h.round.describe().phase, 'starting');
        assert.deepEqual(h.round.describe().participants, ['a']);
    });

    it('resolves at the timeout with whatever arrived; no-shows score nothing', () => {
        const h = createRoundHarness(stopTheClockModule, 'stop-the-clock', ['a', 'b']);
        h.playAttempt();
        h.round.submitResult('a', 0, stopAt(1000));
        h.clock.advance(stopTheClockModule.resultTimeoutMs(h.roundData[0]!.data as StopTheClockRound));

        assert.equal(h.resolved.length, 1);
        assert.equal(h.resolved[0]!.winnerId, 'a');
        assert.deepEqual(h.resolved[0]!.noShow, ['b']);
        assert.equal(h.resolved[0]!.isFinal, true);
    });

    it('resolves straight away once everyone has reported', () => {
        const h = createRoundHarness(stopTheClockModule, 'stop-the-clock', ['a', 'b']);
        h.playAttempt();
        const target = targetOf(h.roundData[0]!.data);
        h.round.submitResult('a', 0, stopAt(target + 50));
        h.round.submitResult('b', 0, stopAt(target - 10));
        assert.equal(h.resolved[0]!.winnerId, 'b');
    });

    it('when nobody reports, the round awards no point rather than inventing a winner', () => {
        const h = createRoundHarness(stopTheClockModule, 'stop-the-clock', ['a', 'b']);
        h.playAttempt();
        h.clock.advance(stopTheClockModule.resultTimeoutMs(h.roundData[0]!.data as StopTheClockRound));
        assert.equal(h.resolved[0]!.winnerId, null);
        assert.equal(h.resolved[0]!.isFinal, true);
    });

    it('latency cannot change the outcome: a result arriving 600 ms later ranks the same', () => {
        const rankWithDelay = (delayMs: number) => {
            const h = createRoundHarness(stopTheClockModule, 'stop-the-clock', ['a', 'b']);
            h.playAttempt();
            const target = targetOf(h.roundData[0]!.data);
            h.round.submitResult('b', 0, stopAt(target + 30));
            h.clock.advance(delayMs);
            h.round.submitResult('a', 0, stopAt(target + 20));
            return h.resolved[0]!.ranked.map((row) => [row.playerId, row.rank]);
        };
        assert.deepEqual(rankWithDelay(0), rankWithDelay(600));
    });

    it('cancel stops every timer', () => {
        const h = createRoundHarness(stopTheClockModule, 'stop-the-clock', ['a', 'b']);
        h.round.cancel();
        assert.equal(h.clock.pendingCount, 0);
        h.clock.advance(SELF_TIMED.READY_CHECK_TIMEOUT_MS * 2);
        assert.equal(h.resolved.length, 0);
    });
});
