/**
 * Closing a round early, for games that end before everyone has finished
 * (Crusher Escalator, Log Dodge, Minefield).
 *
 * Players still playing can only tell the round is over by watching others,
 * so once the game says it is decided they are told to stop and report, and
 * given a short grace before the round is scored without them. The notice is
 * sent once per attempt and decides nothing by itself.
 */

import { SELF_TIMED } from '../../shared/constants.js';
import { TimerSlot, type Scheduler } from '../platform/scheduler.js';

export class EarlyClosing {
    private sent = false;
    private readonly graceTimer: TimerSlot;

    /**
     * @param announce tells the room who must stop, and how long they have.
     * @param onGraceOver scores the round without whoever is still missing.
     */
    constructor(
        scheduler: Scheduler,
        private readonly announce: (pending: string[], graceMs: number) => void,
        private readonly onGraceOver: () => void
    ) {
        this.graceTimer = new TimerSlot(scheduler);
    }

    get hasClosed(): boolean {
        return this.sent;
    }

    close(pending: string[]): void {
        if (this.sent) return;
        this.sent = true;
        this.announce(pending, SELF_TIMED.CLOSING_GRACE_MS);
        this.graceTimer.set(SELF_TIMED.CLOSING_GRACE_MS, this.onGraceOver);
    }

    /** A new attempt, or the round resolved: forget the notice and its timer. */
    reset(): void {
        this.sent = false;
        this.graceTimer.clear();
    }
}
