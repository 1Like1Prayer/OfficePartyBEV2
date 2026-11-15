/**
 * What the self-timed round runner tells the outside world, and what the
 * outside world can read from it. The room adapter turns these into schema
 * state (lifecycle, progress) and reliable messages (round data, closing,
 * results).
 */

import type { GameId } from '../../shared/games/catalog.js';
import type { RankedEntry } from '../../shared/games/selfTimed.js';
import type {
    RoundClosingPayload,
    RoundDataPayload,
    RoundPhase
} from '../../shared/protocol.js';
import type { AnySelfTimedModule } from '../games/registry.js';

export interface AttemptResolved {
    roundId: number;
    attempt: number;
    isTiebreak: boolean;
    ranked: RankedEntry[];
    noShow: string[];
    winnerId: string | null;
    decidedByCoinFlip: boolean;
    /** The players going on to the next stage, if the game has one. */
    advancing: string[] | null;
    /** Pause before the next stage loads. Zero when there is no next stage. */
    stageBreakMs: number;
    /** False when a tie or a stage sent this round to another attempt. */
    isFinal: boolean;
}

export interface SelfTimedRoundEvents {
    /** A new attempt is loading: send its public data to everyone. */
    onRoundData(payload: RoundDataPayload): void;
    /** Phase, readiness or schedule changed: re-read `describe()`. */
    onLifecycleChanged(): void;
    /** A player's display-only progress, already validated and rate limited. */
    onProgress(playerId: string, progress: Record<string, number>): void;
    /** The round's shared world changed (see SharedWorld): these are all its values now. */
    onSharedChanged(values: Readonly<Record<string, number>>): void;
    /** The round is decided; the listed players must stop and report. */
    onRoundClosing(payload: RoundClosingPayload): void;
    onAttemptResolved(resolved: AttemptResolved): void;
}

export interface SelfTimedRoundOptions {
    module: AnySelfTimedModule;
    gameId: GameId;
    roundId: number;
    roundInGame: number;
    roundsPerGame: number;
    events: SelfTimedRoundEvents;
}

/** Everything a client needs to draw the round's lifecycle. */
export interface RoundDescription {
    phase: RoundPhase;
    roundId: number;
    attempt: number;
    gameId: GameId;
    isTiebreak: boolean;
    participants: string[];
    ready: string[];
    waitingFor: string[];
    /** Room-timeline time the ready check gives up. Zero outside a ready check. */
    readyDeadlineMs: number;
    /** Room-timeline time the countdown begins, once scheduled. */
    startAtMs: number | null;
    countdownMs: number;
    /** When the clock actually runs: the zero clients measure from. */
    timingStartsAtMs: number | null;
    resultTimeoutMs: number;
}
