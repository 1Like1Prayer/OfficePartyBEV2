/**
 * Building a playlist: random mode picks for the owner, custom mode keeps
 * their order. Only games that are actually built can be picked.
 */

import { GAME_CATALOG, type GameId } from '../../shared/games/catalog.js';
import { shuffled } from '../../shared/games/random.js';
import { isPlayable, playableGameIds } from '../games/registry.js';

export type PlaylistBuild =
    | { ok: true; playlist: GameId[] }
    | { ok: false; message: string };

/** Every playable game, once each, in a shuffled order. */
export const buildRandomPlaylist = (): GameId[] => shuffled(playableGameIds());

/** Custom mode keeps the owner's order and rejects anything unplayable or repeated. */
export const buildCustomPlaylist = (requested: readonly GameId[]): PlaylistBuild => {
    // No upper limit: any number of distinct playable games, which the catalog bounds anyway.
    if (requested.length < 1) return { ok: false, message: 'Pick at least one game.' };
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
