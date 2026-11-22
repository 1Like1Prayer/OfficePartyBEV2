/**
 * Validators for what a Skribbl client sends. Zod 4 implements
 * StandardSchema, so Colyseus runs them before a handler sees the message.
 * Bounds are generous; the controllers clamp and trim.
 */

import { z } from 'zod';
import { SKRIBBL_CHAT, SKRIBBL_SETTINGS } from '../../../../shared/standalone/skribbl/constants.js';

const setting = (max: number) => z.number().int().min(0).max(max * 10);

export const updateSettingsRequest = z.object({
    rounds: setting(SKRIBBL_SETTINGS.ROUNDS.max).optional(),
    drawTimeSec: setting(SKRIBBL_SETTINGS.DRAW_TIME_SEC.max).optional(),
    wordChoices: setting(SKRIBBL_SETTINGS.WORD_CHOICES.max).optional(),
    hints: setting(SKRIBBL_SETTINGS.HINTS.max).optional()
});

export const chooseWordRequest = z.object({
    turnId: z.number().int().nonnegative(),
    index: z.number().int().nonnegative().max(SKRIBBL_SETTINGS.WORD_CHOICES.max)
});

export const sayRequest = z.object({
    text: z.string().max(SKRIBBL_CHAT.MAX_LENGTH * 4)
});
