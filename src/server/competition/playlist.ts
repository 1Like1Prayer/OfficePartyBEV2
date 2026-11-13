/**
 * Building a playlist: random mode picks for the owner, custom mode keeps
 * their order. Only games that are actually built can be picked.
 */

import { COMPETITION } from '../../shared/constants.js';
import { GAME_CATALOG, type GameId } from '../../shared/games/catalog.js';
import { shuffled } from '../../shared/games/random.js';
import { isPlayable, playableGameIds } from '../games/registry.js';

export type PlaylistBuild =
    | { ok: true; playlist: GameId[] }
    | { ok: false; message: string };

/** Up to RANDOM_PLAYLIST_SIZE distinct games, shuffled. */
export const buildRandomPlaylist = (): GameId[] =>
    shuffled(playableGameIds()).slice(0, COMPETITION.RANDOM_PLAYLIST_SIZE);

/** Custom mode keeps the owner's order and rejects anything unplayable or repeated. */
export const buildCustomPlaylist = (requested: readonly GameId[]): PlaylistBuild => {
    if (requested.length < 1 || requested.length > COMPETITION.MAX_CUSTOM_PLAYLIST_SIZE) {
        return {
            ok: false,
            message: `Pick between 1 and ${COMPETITION.MAX_CUSTOM_PLAYLIST_SIZE} games.`
        };
    }
    const seen = new Set<GameId>();
    for (const gameId of requested) {
        if (!isPlayable(gameId)) {
            return { ok: false, message: `${GAME_CATALOG[gameId].title} isn't playable yet.` };
        }
        if (seen.has(gameId)) return { ok: false, message: 'Games must be distinct.' };
        seen.add(gameId);
    }
    return { ok: true, playlist: [...requested] };
};
