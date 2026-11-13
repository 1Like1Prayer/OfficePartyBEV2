/**
 * What happens after an attempt is ranked: another stage, a tiebreaker, or
 * the end of the scoring round. A pure decision, so it is tested directly.
 *
 * A stage advance is checked first, so it is never mistaken for a tie. A
 * scoring round always hands back exactly one winner: if a tie survives every
 * tiebreaker, the winner is drawn at random and the result says so.
 */

import { SELF_TIMED } from '../../shared/constants.js';
import type { RankedEntry, StageAdvance } from '../../shared/games/selfTimed.js';
import type { RandomSource } from '../../shared/games/random.js';
import type { AttemptResolved } from './roundTypes.js';

export type AttemptOutcome =
    | { kind: 'next-stage'; stage: StageAdvance }
    | { kind: 'tiebreak'; tied: string[] }
    | { kind: 'finished'; winnerId: string | null; decidedByCoinFlip: boolean };

export const leadersOf = (ranked: readonly RankedEntry[]): string[] =>
    ranked.filter((row) => row.rank === 1).map((row) => row.playerId);

export const decideAttemptOutcome = (
    ranked: readonly RankedEntry[],
    stage: StageAdvance | null,
    tiebreakersRun: number,
    random: RandomSource = Math.random
): AttemptOutcome => {
    if (stage !== null) return { kind: 'next-stage', stage };

    const leaders = leadersOf(ranked);
    const canRetry =
        leaders.length > 1 && tiebreakersRun < SELF_TIMED.MAX_TIEBREAK_ATTEMPTS - 1;
    if (canRetry) return { kind: 'tiebreak', tied: leaders };

    if (leaders.length === 0) {
        return { kind: 'finished', winnerId: null, decidedByCoinFlip: false };
    }
    if (leaders.length === 1) {
        return { kind: 'finished', winnerId: leaders[0]!, decidedByCoinFlip: false };
    }
    // Tiebreakers exhausted. Draw, and say so rather than pretending.
    const winnerId = leaders[Math.floor(random() * leaders.length)]!;
    return { kind: 'finished', winnerId, decidedByCoinFlip: true };
};

/** How an outcome reads in the results message. */
export const describeOutcome = (
    outcome: AttemptOutcome
): Pick<AttemptResolved, 'winnerId' | 'decidedByCoinFlip' | 'isFinal' | 'advancing' | 'stageBreakMs'> => {
    const notFinal = { winnerId: null, decidedByCoinFlip: false, isFinal: false };
    switch (outcome.kind) {
        case 'next-stage':
            return {
                ...notFinal,
                advancing: outcome.stage.participants,
                stageBreakMs: outcome.stage.pauseMs
            };
        case 'tiebreak':
            return { ...notFinal, advancing: null, stageBreakMs: 0 };
        case 'finished':
            return {
                winnerId: outcome.winnerId,
                decidedByCoinFlip: outcome.decidedByCoinFlip,
                isFinal: true,
                advancing: null,
                stageBreakMs: 0
            };
    }
};
