/**
 * Who is in the current attempt, and where each of them is: ready or not,
 * reported or not, dropped mid-attempt or not. Pure bookkeeping, reset at the
 * start of every attempt.
 */

import type { ResultEntry } from '../../shared/games/selfTimed.js';

export class AttemptRoster {
    private participants = new Set<string>();
    private readonly ready = new Set<string>();
    private readonly results = new Map<string, unknown>();
    /** Dropped mid-attempt; a brief blip must not cost them the round. */
    private readonly dropped = new Set<string>();

    reset(participants: readonly string[]): void {
        this.participants = new Set(participants);
        this.ready.clear();
        this.results.clear();
        this.dropped.clear();
    }

    get size(): number {
        return this.participants.size;
    }

    has(playerId: string): boolean {
        return this.participants.has(playerId);
    }

    list(): string[] {
        return [...this.participants];
    }

    /* ------------------------------ ready check ----------------------------- */

    /** Returns false if they were already ready. */
    markReady(playerId: string): boolean {
        if (this.ready.has(playerId)) return false;
        this.ready.add(playerId);
        return true;
    }

    /** Takes back their ready. Returns false if they were not ready. */
    markUnready(playerId: string): boolean {
        return this.ready.delete(playerId);
    }

    readyList(): string[] {
        return this.list().filter((id) => this.ready.has(id));
    }

    waitingFor(): string[] {
        return this.list().filter((id) => !this.ready.has(id));
    }

    allReady(): boolean {
        return this.size > 0 && this.waitingFor().length === 0;
    }

    /** The ready check timed out: whoever never acknowledged sits this attempt out. */
    removeUnready(): void {
        for (const playerId of this.waitingFor()) this.participants.delete(playerId);
    }

    /* -------------------------------- results ------------------------------- */

    hasResult(playerId: string): boolean {
        return this.results.has(playerId);
    }

    recordResult(playerId: string, result: unknown): void {
        this.results.set(playerId, result);
    }

    /** Every result that came in, including from players who have since dropped. */
    resultEntries(): ResultEntry<unknown>[] {
        return [...this.results].map(([playerId, result]) => ({ playerId, result }));
    }

    /** Results from players still in the attempt, for the game's early-close check. */
    participantResults(): ResultEntry<unknown>[] {
        return this.list().flatMap((playerId) =>
            this.results.has(playerId) ? [{ playerId, result: this.results.get(playerId) }] : []
        );
    }

    /** Participants the attempt is still waiting on for a result. */
    pending(): string[] {
        return this.list().filter((id) => !this.results.has(id));
    }

    /* ------------------------------ membership ------------------------------ */

    /** Returns false if they were not playing. */
    drop(playerId: string): boolean {
        if (!this.participants.delete(playerId)) return false;
        this.ready.delete(playerId);
        this.dropped.add(playerId);
        return true;
    }

    /** Only a player who dropped out of this attempt can come back into it. */
    rejoin(playerId: string): boolean {
        if (!this.dropped.delete(playerId)) return false;
        this.participants.add(playerId);
        return true;
    }
}
