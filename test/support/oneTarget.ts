/**
 * Stop the Clock cut down to a single target: no stages, ranked like a
 * tiebreaker. The round runner's own tests use it as the simplest real game,
 * so what they check is the runner, not Stop the Clock's four-target round.
 */

import { rankTarget, stopTheClockModule } from '../../src/shared/games/stopTheClock.js';

export const oneTargetStopTheClock: typeof stopTheClockModule = {
    ...stopTheClockModule,
    finishAnimationMs: undefined,
    nextStage: undefined,
    rank: rankTarget
};
