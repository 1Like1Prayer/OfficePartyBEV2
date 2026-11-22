/**
 * Copies the round runner's view into `state.round`. The runner stays
 * framework-free; this is the only place its output meets the schema.
 */

import type { RoundPosition } from '../../competition/competition.js';
import type { RoundDescription } from '../../rounds/roundTypes.js';
import { ProgressState, type RoundState } from './schema/RoundState.js';
import { replaceArray, replaceMap } from '../../platform/schema/sync.js';

/** Which game of the playlist this is, and which of its rounds. */
export const writeRoundPosition = (round: RoundState, position: RoundPosition): void => {
    round.gameId = position.gameId;
    round.gameIndex = position.gameIndex;
    round.totalGames = position.totalGames;
    round.roundInGame = position.roundInGame;
    round.roundsPerGame = position.roundsPerGame;
};

export const writeRoundDescription = (round: RoundState, view: RoundDescription): void => {
    round.phase = view.phase;
    round.roundId = view.roundId;
    round.attempt = view.attempt;
    round.gameId = view.gameId;
    round.isTiebreak = view.isTiebreak;
    replaceArray(round.participants, view.participants);
    replaceArray(round.ready, view.ready);
    replaceArray(round.waitingFor, view.waitingFor);
    round.startAtMs = view.startAtMs ?? undefined;
    round.countdownMs = view.countdownMs;
    round.timingStartsAtMs = view.timingStartsAtMs ?? undefined;
    round.resultTimeoutMs = view.resultTimeoutMs;
};

export const writeProgress = (
    round: RoundState,
    playerId: string,
    progress: Readonly<Record<string, number>>
): void => {
    let entry = round.progress.get(playerId);
    if (entry === undefined) {
        entry = new ProgressState();
        round.progress.set(playerId, entry);
    }
    replaceMap(entry.values, progress);
};

export const clearProgress = (round: RoundState): void => {
    round.progress.clear();
};

/** A new round starts with an empty shared world: each runner only clears the values it wrote itself. */
export const clearShared = (round: RoundState): void => {
    round.shared.clear();
};

export const writeShared = (round: RoundState, values: Readonly<Record<string, number>>): void => {
    replaceMap(round.shared, values);
};

/** Back to the lobby: no round. */
export const resetRound = (round: RoundState): void => {
    round.phase = 'idle';
    round.attempt = 0;
    round.gameId = '';
    round.gameIndex = 0;
    round.totalGames = 0;
    round.roundInGame = 0;
    round.roundsPerGame = 0;
    round.isTiebreak = false;
    replaceArray(round.participants, []);
    replaceArray(round.ready, []);
    replaceArray(round.waitingFor, []);
    round.startAtMs = undefined;
    round.countdownMs = 0;
    round.timingStartsAtMs = undefined;
    round.resultTimeoutMs = 0;
    clearProgress(round);
    clearShared(round);
};
