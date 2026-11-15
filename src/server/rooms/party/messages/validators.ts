/**
 * Validators for everything a client sends. Zod 4 implements StandardSchema,
 * so Colyseus runs these itself before a handler sees the message.
 *
 * Game-specific payloads (results, actions, progress) are only checked for
 * their envelope here; each game module parses its own contents.
 */

import { z } from 'zod';
import { AVATAR, ROOM } from '../../../../shared/constants.js';
import { GAME_IDS } from '../../../../shared/games/catalog.js';

/** Generous: names are trimmed and cut by `sanitizeName`; this only refuses absurd payloads. */
const nameField = z.string().max(ROOM.MAX_NAME_LENGTH * 4);

/**
 * Deliberately lenient: an avatar is cosmetic, so a bad one must never stop
 * someone getting into the room. `sanitizeAvatar` decides if it is usable.
 */
const avatarField = z.string().max(AVATAR.MAX_PAYLOAD_LENGTH);

export const joinOptions = z.object({
    protocolVersion: z.number(),
    name: nameField.optional(),
    avatar: avatarField.optional()
});

export const setNameRequest = z.object({ name: nameField });

export const setModeRequest = z.object({
    mode: z.enum(['random', 'custom']),
    // Bounded by the catalog: a playlist cannot hold more distinct games than exist.
    gameIds: z.array(z.enum(GAME_IDS)).max(GAME_IDS.length).optional()
});

export const setReadyRequest = z.object({ ready: z.boolean() });

export const kickPlayerRequest = z.object({ playerId: z.string().min(1).max(64) });

export const roundEnvelope = z.object({
    roundId: z.number().int().nonnegative(),
    attempt: z.number().int().nonnegative()
});

export const submitResultRequest = roundEnvelope.extend({ result: z.unknown() });

export const roundActionRequest = roundEnvelope.extend({ action: z.unknown() });

/**
 * Checked inside the handler rather than registered with Colyseus: a failed
 * validator on a fire-and-forget message disconnects the client, and a
 * display-only update is never worth that.
 */
export const progressMessage = roundEnvelope.extend({ progress: z.unknown() });
