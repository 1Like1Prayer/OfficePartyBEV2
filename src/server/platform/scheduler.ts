/**
 * Time, as the server's game logic sees it.
 *
 * The round runner and the match flow are written against this interface,
 * not against Colyseus, so they stay framework-free and a test can drive them
 * with a fake clock. In the room it is backed by:
 *
 * - **now()**: a monotonic room timeline (milliseconds since the room was
 *   created). It is read fresh on every call, so a ping reply is exact rather
 *   than up to one clock tick stale, and an OS clock adjustment can never move
 *   a deadline. Every server-stamped instant clients see (starts, deadlines,
 *   ping replies) is on this timeline.
 * - **after()**: the room's Colyseus clock, so timers are cleared with the
 *   room and wrapped by its error handling.
 */

import type { Clock } from 'colyseus';

export type CancelTimer = () => void;

export interface Scheduler {
    /** Milliseconds on the room timeline. Monotonic. */
    now(): number;
    /** Run `callback` once, after `delayMs`. Returns a function that cancels it. */
    after(delayMs: number, callback: () => void): CancelTimer;
}

/** A monotonic clock starting at zero when created. */
export const createRoomTimeline = (): (() => number) => {
    const originMs = performance.now();
    return () => performance.now() - originMs;
};

export const createRoomScheduler = (clock: Clock, timeline: () => number): Scheduler => ({
    now: timeline,
    after: (delayMs, callback) => {
        const delayed = clock.setTimeout(callback, Math.max(0, delayMs));
        return () => delayed.clear();
    }
});

/**
 * A timer slot that holds at most one pending callback: scheduling a new one
 * replaces the old. Most phases of a round wait on exactly one thing.
 */
export class TimerSlot {
    private cancel: CancelTimer | null = null;

    constructor(private readonly scheduler: Scheduler) {}

    get isPending(): boolean {
        return this.cancel !== null;
    }

    set(delayMs: number, callback: () => void): void {
        this.clear();
        this.cancel = this.scheduler.after(delayMs, () => {
            this.cancel = null;
            callback();
        });
    }

    clear(): void {
        this.cancel?.();
        this.cancel = null;
    }
}
