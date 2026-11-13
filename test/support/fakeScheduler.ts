/**
 * A Scheduler whose time only moves when a test says so. Timers fire in
 * due order, including timers scheduled by other timers while advancing.
 */

import type { CancelTimer, Scheduler } from '../../src/server/platform/scheduler.js';

interface PendingTimer {
    id: number;
    dueAtMs: number;
    callback: () => void;
}

export class FakeScheduler implements Scheduler {
    private nowMs = 0;
    private nextId = 0;
    private timers: PendingTimer[] = [];

    now(): number {
        return this.nowMs;
    }

    after(delayMs: number, callback: () => void): CancelTimer {
        const timer = { id: ++this.nextId, dueAtMs: this.nowMs + Math.max(0, delayMs), callback };
        this.timers.push(timer);
        return () => {
            this.timers = this.timers.filter((pending) => pending.id !== timer.id);
        };
    }

    /** Move time forward, firing every timer that comes due on the way. */
    advance(ms: number): void {
        const targetMs = this.nowMs + ms;
        for (;;) {
            const due = this.timers
                .filter((timer) => timer.dueAtMs <= targetMs)
                .sort((a, b) => a.dueAtMs - b.dueAtMs || a.id - b.id)[0];
            if (due === undefined) break;
            this.timers = this.timers.filter((timer) => timer.id !== due.id);
            this.nowMs = due.dueAtMs;
            due.callback();
        }
        this.nowMs = targetMs;
    }

    get pendingCount(): number {
        return this.timers.length;
    }
}
