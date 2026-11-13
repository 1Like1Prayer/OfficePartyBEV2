/**
 * One player, as everyone in the room sees them. Keyed by Colyseus
 * `sessionId`, which survives a reconnect.
 *
 * Every field here is public by design: add a field only if every player may
 * see it (hidden information never goes into state).
 */

import { schema, t, type SchemaType } from '@colyseus/schema';

export const PlayerState = schema(
    {
        id: t.string(),
        name: t.string(),
        /** Avatar seed the player picked; the client draws from it. */
        avatar: t.string(),
        connected: t.boolean().default(true),
        isOwner: t.boolean().default(false),
        /** Joined after the competition started, so they watch until the next lobby. */
        isSpectator: t.boolean().default(false),
        /** Pressed ready in the lobby. The owner is always ready. */
        ready: t.boolean().default(false),
        points: t.uint16().default(0),
        /** Join order. Owner succession goes to the longest-connected player. */
        joinOrder: t.uint32().default(0)
    },
    'PlayerState'
);
export type PlayerState = SchemaType<typeof PlayerState>;
