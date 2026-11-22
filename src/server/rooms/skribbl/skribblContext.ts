/**
 * What the Skribbl room's controllers share: the synced state, the room's
 * time and randomness, and the ways to reach players. Passing this instead
 * of the Colyseus Room lets a test drive the game without a server.
 */

import type { Scheduler } from '../../platform/scheduler.js';
import type { RandomInt } from '../../standalone/skribbl/wordBank.js';
import type { SkribblState } from './schema/SkribblState.js';

export interface SkribblContext {
    readonly state: SkribblState;
    readonly scheduler: Scheduler;
    readonly randomInt: RandomInt;
    /** Reliable message to everyone in the room. */
    broadcast(type: string, payload: unknown): void;
    /** Reliable message to one player, if they are connected. */
    sendTo(playerId: string, type: string, payload: unknown): void;
    /** Binary message to everyone but `exceptId`. */
    broadcastBytes(type: string, bytes: Uint8Array, exceptId: string): void;
    /** Binary message to one player, if they are connected. */
    sendBytesTo(playerId: string, type: string, bytes: Uint8Array): void;
}
