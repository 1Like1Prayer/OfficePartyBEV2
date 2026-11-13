/**
 * The result of a client action. A refusal carries the `RequestError` the
 * client's `room.request()` rejects with, so a rule deep in the game logic
 * can explain itself without knowing anything about the transport.
 */

import type { ErrorCode, RequestError } from '../../shared/protocol.js';

export type Outcome<T = null> =
    | { ok: true; value: T }
    | { ok: false; error: RequestError };

export const succeed = <T>(value: T): Outcome<T> => ({ ok: true, value });

export const done: Outcome<null> = { ok: true, value: null };

export const refuse = (code: ErrorCode, message: string): Outcome<never> => ({
    ok: false,
    error: { code, message }
});
