import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ClockSync, nextPingDelayMs } from './clockSync.js';
import { CLOCK_SYNC } from './constants.js';

/** The server's clock runs this far ahead of the local one in these tests. */
const TRUE_OFFSET_MS = 10_000;

/** A ping with the given one-way delays, sent at `sentAt` local time. */
const ping = (sync: ClockSync, sentAt: number, upMs: number, downMs: number) => {
    const serverTimeMs = sentAt + upMs + TRUE_OFFSET_MS;
    sync.addSample(sentAt, sentAt + upMs + downMs, serverTimeMs);
};

describe('clock sync', () => {
    it('a symmetric round trip gives the exact offset', () => {
        const sync = new ClockSync();
        ping(sync, 0, 40, 40);
        assert.equal(sync.serverNow(80), 80 + TRUE_OFFSET_MS);
        assert.equal(sync.toLocalTime(TRUE_OFFSET_MS + 500, 80), 500);
    });

    it('trusts the lowest round trip, whose error is smallest', () => {
        const sync = new ClockSync({ snapThresholdMs: Infinity, maxSlewRate: 1 });
        ping(sync, 0, 20, 20);
        ping(sync, 1_000, 300, 20); // queued on the way up: a skewed sample
        assert.equal(sync.bestRoundTripMs, 40);
        assert.equal(sync.serverNow(2_000), 2_000 + TRUE_OFFSET_MS);
    });

    it('eases toward a better estimate instead of jumping', () => {
        const sync = new ClockSync();
        ping(sync, 0, 100, 0); // asymmetric: the first estimate is 50 ms early
        const firstEstimate = sync.serverNow(100);
        ping(sync, 1_000, 5, 5); // a better sample says +50 ms
        const afterOneMs = sync.serverNow(1_011) - 1_011;
        const before = firstEstimate - 100;
        assert.ok(afterOneMs - before <= 1 * CLOCK_SYNC.MAX_SLEW_RATE + 1e-9, 'bounded slew');

        const later = sync.serverNow(5_000) - 5_000;
        assert.ok(Math.abs(later - TRUE_OFFSET_MS) < 1, 'converged');
    });

    it('snaps on a jump larger than the threshold (e.g. a frozen tab)', () => {
        const sync = new ClockSync();
        ping(sync, 0, 10, 10);
        sync.addSample(1_000, 1_020, 1_010 + TRUE_OFFSET_MS + 5_000);
        assert.ok(Math.abs(sync.serverNow(1_020) - (1_020 + TRUE_OFFSET_MS + 5_000)) < 1);
    });

    it('pings in a quick burst after joining, then slowly', () => {
        assert.equal(nextPingDelayMs(0), CLOCK_SYNC.BURST_INTERVAL_MS);
        assert.equal(nextPingDelayMs(CLOCK_SYNC.BURST_SIZE), CLOCK_SYNC.INTERVAL_MS);
    });
});
