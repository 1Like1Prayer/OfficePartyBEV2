/**
 * Display-only progress, rate limited per player.
 *
 * An update that arrives inside the rate limit is not thrown away: the newest
 * one waits and goes out as soon as the limit allows, and a newer update
 * replaces it. Otherwise a player who pauses right after two quick updates
 * would look stuck on everyone else's screen.
 */

import { SELF_TIMED } from '../../shared/constants.js';
import type { CancelTimer, Scheduler } from '../platform/scheduler.js';

type Progress = Record<string, number>;

interface HeldUpdate {
    progress: Progress;
    cancel: CancelTimer;
}

export class ProgressRelay {
    private readonly lastSentAt = new Map<string, number>();
    private readonly held = new Map<string, HeldUpdate>();

    /**
     * @param deliver publishes an update to the room.
     * @param stillWanted checked before a held update goes out, so nothing is
     *   published for a player who has left or a round that has ended.
     */
    constructor(
        private readonly scheduler: Scheduler,
        private readonly deliver: (playerId: string, progress: Progress) => void,
        private readonly stillWanted: (playerId: string) => boolean
    ) {}

    /** Send now if the rate limit allows, otherwise hold the newest update. */
    submit(playerId: string, progress: Progress): void {
        const sinceLastMs = this.scheduler.now() - (this.lastSentAt.get(playerId) ?? -Infinity);
        const waitMs = SELF_TIMED.PROGRESS_MIN_INTERVAL_MS - sinceLastMs;
        if (waitMs <= 0) {
            this.sendNow(playerId, progress);
            return;
        }

        const waiting = this.held.get(playerId);
        if (waiting !== undefined) {
            waiting.progress = progress;
            return;
        }
        const cancel = this.scheduler.after(waitMs, () => {
            const entry = this.held.get(playerId);
            this.held.delete(playerId);
            if (entry !== undefined && this.stillWanted(playerId)) {
                this.sendNow(playerId, entry.progress);
            }
        });
        this.held.set(playerId, { progress, cancel });
    }

    /** Bypass the rate limit: for what the server itself knows (e.g. a knock-out). */
    sendNow(playerId: string, progress: Progress): void {
        this.dropHeld(playerId);
        this.lastSentAt.set(playerId, this.scheduler.now());
        this.deliver(playerId, progress);
    }

    /** Forget any held update, for one player or for everyone. */
    dropHeld(playerId?: string): void {
        for (const [id, entry] of this.held) {
            if (playerId !== undefined && id !== playerId) continue;
            entry.cancel();
            this.held.delete(id);
        }
    }

    /** A new attempt starts from a clean slate. */
    reset(): void {
        this.dropHeld();
        this.lastSentAt.clear();
    }
}
