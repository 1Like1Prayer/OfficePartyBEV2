/**
 * The Skribbl room's synced state. Clients render from this plus the
 * reliable messages in shared/standalone/skribbl/protocol.ts.
 *
 * Everything here is public. The word is never in state, only its pattern:
 * the drawer and players who guessed it get the word in a private message.
 * Times are on the room timeline (milliseconds since the room was created).
 */

import { schema, t, type SchemaType } from '@colyseus/schema';
import { SKRIBBL_SETTINGS } from '../../../../shared/standalone/skribbl/constants.js';
import { STANDALONE_CATALOG } from '../../../../shared/standalone/catalog.js';
import { PlayerState } from '../../../platform/schema/PlayerState.js';

export const SettingsState = schema(
    {
        rounds: t.uint8().default(SKRIBBL_SETTINGS.ROUNDS.default),
        drawTimeSec: t.uint16().default(SKRIBBL_SETTINGS.DRAW_TIME_SEC.default),
        wordChoices: t.uint8().default(SKRIBBL_SETTINGS.WORD_CHOICES.default),
        hints: t.uint8().default(SKRIBBL_SETTINGS.HINTS.default)
    },
    'SkribblSettingsState'
);
export type SettingsState = SchemaType<typeof SettingsState>;

export const TurnState = schema(
    {
        /** TurnPhase. */
        phase: t.string().default('idle'),
        turnId: t.uint32().default(0),
        round: t.uint8().default(0),
        totalRounds: t.uint8().default(0),
        drawerId: t.string().default(''),
        /** When the current turn phase ends; 0 when nothing is timed. */
        endsAtMs: t.number().default(0),
        drawTimeMs: t.number().default(0),
        /** '_' per hidden letter; the whole word once the turn ends. */
        wordPattern: t.string().default(''),
        /** Who guessed this turn, in order. */
        guessed: t.array('string')
    },
    'SkribblTurnState'
);
export type TurnState = SchemaType<typeof TurnState>;

export const SkribblState = schema(
    {
        roomCode: t.string(),
        /** SkribblPhase. */
        phase: t.string().default('lobby'),
        ownerId: t.string().default(''),
        players: t.map(PlayerState),
        settings: t.ref(SettingsState),
        canStart: t.boolean().default(false),
        /** 'not_enough_players', or ''. */
        blockedReason: t.string().default(''),
        minPlayers: t.uint8().default(STANDALONE_CATALOG.skribbl.minPlayers),
        maxPlayers: t.uint8().default(STANDALONE_CATALOG.skribbl.maxPlayers),
        turn: t.ref(TurnState)
    },
    'SkribblState'
);
export type SkribblState = SchemaType<typeof SkribblState>;
