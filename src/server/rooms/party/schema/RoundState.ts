/**
 * The current scoring round's lifecycle and live progress.
 *
 * This is the "snapshot" half of the round: it is delta-synced, so a phase
 * change or a progress tick costs a few bytes, and a reconnecting client gets
 * all of it at once. The round's game data and results are one-off events and
 * travel as reliable messages instead (see shared/protocol.ts).
 *
 * All times are on the room timeline (milliseconds since the room was
 * created); clients convert them with their ClockSync estimate.
 */

import { schema, t, type SchemaType } from '@colyseus/schema';

/** One player's display-only progress. Keys and meaning are the game's own. */
export const ProgressState = schema(
    {
        values: t.map('number')
    },
    'ProgressState'
);
export type ProgressState = SchemaType<typeof ProgressState>;

export const RoundState = schema(
    {
        /** RoundPhase. */
        phase: t.string().default('idle'),
        roundId: t.uint32().default(0),
        attempt: t.uint8().default(0),
        /** GameId, or '' before the first round. */
        gameId: t.string().default(''),
        /** Which game of the playlist (1-based) and which of its rounds. */
        gameIndex: t.uint8().default(0),
        totalGames: t.uint8().default(0),
        roundInGame: t.uint8().default(0),
        roundsPerGame: t.uint8().default(0),
        isTiebreak: t.boolean().default(false),
        participants: t.array('string'),
        /** The ready check is visible so everyone can see who the room waits on. */
        ready: t.array('string'),
        waitingFor: t.array('string'),
        /** When the ready check gives up. Zero outside a ready check. */
        readyDeadlineMs: t.number().default(0),
        /** When the countdown begins, once the start is scheduled. */
        startAtMs: t.number().optional(),
        countdownMs: t.number().default(0),
        /** When the clock runs: the zero every client measures its result from. */
        timingStartsAtMs: t.number().optional(),
        resultTimeoutMs: t.number().default(0),
        /** Latest progress per player (sessionId), reset every attempt. */
        progress: t.map(ProgressState),
        /**
         * The attempt's shared world: server-owned values under the game's own
         * keys (Hex Drop: when each tile falls). Reset every attempt.
         */
        shared: t.map('number')
    },
    'RoundState'
);
export type RoundState = SchemaType<typeof RoundState>;
