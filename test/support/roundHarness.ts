/**
 * Runs a SelfTimedRound on a fake clock and records everything it emits.
 */

import type { GameId } from '../../src/shared/games/catalog.js';
import type { RoundClosingPayload, RoundDataPayload } from '../../src/shared/protocol.js';
import type { AnySelfTimedModule } from '../../src/server/games/registry.js';
import type { AttemptResolved } from '../../src/server/rounds/roundTypes.js';
import { SelfTimedRound } from '../../src/server/rounds/selfTimedRound.js';
import { FakeScheduler } from './fakeScheduler.js';

export interface RoundHarness {
    round: SelfTimedRound;
    clock: FakeScheduler;
    roundData: RoundDataPayload[];
    progress: Array<{ playerId: string; progress: Record<string, number> }>;
    /** The attempt's shared world, as the room would sync it. */
    shared: Record<string, number>;
    closing: RoundClosingPayload[];
    resolved: AttemptResolved[];
    /** Everyone ready, then advance through the start lead and the countdown. */
    playAttempt(players?: readonly string[]): void;
}

export const createRoundHarness = (
    module: AnySelfTimedModule,
    gameId: GameId,
    players: readonly string[],
    roundInGame = 1
): RoundHarness => {
    const clock = new FakeScheduler();
    const harness = {
        clock,
        roundData: [] as RoundDataPayload[],
        progress: [] as RoundHarness['progress'],
        shared: {} as Record<string, number>,
        closing: [] as RoundClosingPayload[],
        resolved: [] as AttemptResolved[]
    };

    const round = new SelfTimedRound(
        {
            module,
            gameId,
            roundId: 1,
            roundInGame,
            roundsPerGame: module.roundsPerGame,
            events: {
                onRoundData: (payload) => harness.roundData.push(payload),
                onLifecycleChanged: () => undefined,
                onProgress: (playerId, progress) => harness.progress.push({ playerId, progress }),
                onSharedChanged: (values) => {
                    for (const key of Object.keys(harness.shared)) delete harness.shared[key];
                    Object.assign(harness.shared, values);
                },
                onRoundClosing: (payload) => harness.closing.push(payload),
                onAttemptResolved: (payload) => harness.resolved.push(payload)
            }
        },
        clock
    );

    const playAttempt = (who: readonly string[] = round.describe().participants): void => {
        const { attempt } = round.describe();
        for (const playerId of who) round.markReady(playerId, attempt);
        clock.advance(round.describe().startAtMs! - clock.now());
        clock.advance(round.describe().countdownMs);
    };

    round.begin(players);
    return { ...harness, round, playAttempt };
};
