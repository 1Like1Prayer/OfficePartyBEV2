/**
 * Player-supplied identity: display names, avatar seeds and room codes.
 *
 * A player's id is their Colyseus `sessionId`. It survives a reconnect
 * (`allowReconnection` hands the same session back), so it is safe to key
 * scores and round results by it.
 */

import { randomInt } from 'node:crypto';
import { AVATAR, ROOM } from '../../shared/constants.js';

export const sanitizeName = (raw: unknown, fallback: string): string => {
    if (typeof raw !== 'string') return fallback;
    const cleaned = raw.replace(/\s+/g, ' ').trim().slice(0, ROOM.MAX_NAME_LENGTH);
    return cleaned.length > 0 ? cleaned : fallback;
};

/**
 * An avatar seed is shown to everyone in the room, so it is validated rather
 * than trusted: anything that is not a plain token falls back to a stable
 * per-player seed, which always renders something.
 */
export const sanitizeAvatar = (raw: unknown, fallback: string): string =>
    typeof raw === 'string' && AVATAR.SEED_PATTERN.test(raw) ? raw : fallback;

/** A random code from the unambiguous alphabet. */
export const randomRoomCode = (): string => {
    let code = '';
    for (let i = 0; i < ROOM.CODE_LENGTH; i++) {
        code += ROOM.CODE_ALPHABET[randomInt(ROOM.CODE_ALPHABET.length)];
    }
    return code;
};

/**
 * Room codes are short and spoken out loud. `isTaken` lets the caller check
 * the matchmaker so two live rooms never share a code.
 */
export const uniqueRoomCode = async (
    isTaken: (code: string) => Promise<boolean>
): Promise<string> => {
    for (let attempt = 0; attempt < 100; attempt++) {
        const code = randomRoomCode();
        if (!(await isTaken(code))) return code;
    }
    throw new Error('Could not find a free room code.');
};
