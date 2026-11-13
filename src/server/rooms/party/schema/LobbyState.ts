/**
 * Everything the lobby screen needs: the playlist settings the owner picks,
 * and whether start is available. The start rules are evaluated on the
 * server and published here, so the client never re-derives them.
 */

import { schema, t, type SchemaType } from '@colyseus/schema';

export const LobbyState = schema(
    {
        /** 'random' | 'custom' (PlaylistMode). */
        mode: t.string().default('random'),
        /** The owner's picks in custom mode, in order. */
        customPlaylist: t.array('string'),
        /** The set list the owner picks from: games that are actually built. */
        playableGames: t.array('string'),
        /** Scoring rounds each playable game is played for. */
        roundsByGame: t.map('uint8'),
        /** Connected players the room is still waiting on to press ready. */
        waitingFor: t.array('string'),
        canStart: t.boolean().default(false),
        /** StartBlockedReason, or '' when start is available. */
        blockedReason: t.string().default('')
    },
    'LobbyState'
);
export type LobbyState = SchemaType<typeof LobbyState>;
