/**
 * The game registry: the module behind each GameId.
 *
 * Every game runs on the self-timed round runner. Hex Drop is played in one
 * shared world, but each browser moves its own runner and the server only owns
 * the tiles, so the same runner serves it, with its shared world and a faster
 * progress rate (see `SharedWorld` and `progressHz`). Mage Battle keeps every
 * dial and score in that shared world too.
 */

import { GAME_CATALOG, type GameId } from '../../shared/games/catalog.js';
import { crusherEscalatorModule } from '../../shared/games/crusherEscalator/module.js';
import { cubeCounterModule } from '../../shared/games/cubeCounter/module.js';
import { hexDropModule } from '../../shared/games/hexDrop/module.js';
import { mageBattleModule } from '../../shared/games/mageBattle/module.js';
import { logDodgeModule } from '../../shared/games/logDodge/module.js';
import { minefieldModule } from '../../shared/games/minefield/module.js';
import type { SelfTimedGameModule } from '../../shared/games/selfTimed.js';
import { stopTheClockModule } from '../../shared/games/stopTheClock.js';
import { createTypeRacerModule } from '../../shared/games/typeRacer/module.js';
import { hmacRollFace } from './diceRolls.js';

// The registry erases each game's own round/result types; the runner only
// ever passes a module's values back to that same module.
export type AnySelfTimedModule = SelfTimedGameModule<any, any>;

const SELF_TIMED_MODULES: Partial<Record<GameId, AnySelfTimedModule>> = {
    'crusher-escalator': crusherEscalatorModule,
    'cube-counter': cubeCounterModule,
    'hex-drop': hexDropModule,
    'log-dodge': logDodgeModule,
    'mage-battle': mageBattleModule,
    'minefield': minefieldModule,
    'stop-the-clock': stopTheClockModule,
    'type-racer-roulette': createTypeRacerModule(hmacRollFace)
};

export const getSelfTimedModule = (gameId: GameId): AnySelfTimedModule | null =>
    SELF_TIMED_MODULES[gameId] ?? null;

export const isPlayable = (gameId: GameId): boolean =>
    getSelfTimedModule(gameId) !== null && GAME_CATALOG[gameId].implemented;

/** Games a playlist may actually contain right now, in catalogue order. */
export const playableGameIds = (): GameId[] =>
    (Object.keys(GAME_CATALOG) as GameId[]).filter(isPlayable);

/** How many scoring rounds a game is played for. Zero for games that aren't built. */
export const roundsForGame = (gameId: GameId): number =>
    getSelfTimedModule(gameId)?.roundsPerGame ?? 0;
