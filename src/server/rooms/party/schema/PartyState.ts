/**
 * The root state of a party room: who is here, the lobby, the competition's
 * playlist and the round being played. Clients render entirely from this,
 * plus the reliable messages in shared/protocol.ts.
 */

import { schema, t, type SchemaType } from '@colyseus/schema';
import { ROOM } from '../../../../shared/constants.js';
import { LobbyState } from './LobbyState.js';
import { PlayerState } from '../../../platform/schema/PlayerState.js';
import { RoundState } from './RoundState.js';

/** A standalone game opened for the room; both '' when none is. */
export const StandaloneLinkState = schema(
    {
        gameId: t.string().default(''),
        roomCode: t.string().default('')
    },
    'StandaloneLinkState'
);
export type StandaloneLinkState = SchemaType<typeof StandaloneLinkState>;

export const PartyState = schema(
    {
        /** The 4-character code players type to join; also the Colyseus roomId. */
        roomCode: t.string(),
        /** RoomPhase. */
        phase: t.string().default('lobby'),
        ownerId: t.string().default(''),
        players: t.map(PlayerState),
        lobby: t.ref(LobbyState),
        /** The running competition's playlist; empty in the lobby. */
        playlist: t.array('string'),
        totalRounds: t.uint16().default(0),
        round: t.ref(RoundState),
        minPlayers: t.uint8().default(ROOM.MIN_PLAYERS),
        maxPlayers: t.uint8().default(ROOM.MAX_PLAYERS),
        standalone: t.ref(StandaloneLinkState)
    },
    'PartyState'
);
export type PartyState = SchemaType<typeof PartyState>;
