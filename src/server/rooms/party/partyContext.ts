/**
 * What the party room's controllers (members, lobby, match flow) share: the
 * synced state, the room's time, and the two ways to send a reliable message.
 *
 * Passing this instead of the Colyseus Room keeps the controllers thin and
 * lets a test drive them without a server.
 */

import type { Scheduler } from '../../platform/scheduler.js';
import type { PartyState } from './schema/PartyState.js';

export interface PartyContext {
    readonly state: PartyState;
    readonly scheduler: Scheduler;
    /** Reliable message to everyone in the room. */
    broadcast(type: string, payload: unknown): void;
    /** Reliable message to one player, if they are connected. */
    sendTo(playerId: string, type: string, payload: unknown): void;
}
