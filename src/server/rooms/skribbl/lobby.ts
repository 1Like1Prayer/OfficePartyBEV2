/**
 * The Skribbl lobby: the owner sets up the game and starts it once at least
 * two players are connected. There is no ready check; the owner just starts.
 * The start rule is evaluated here and published in state, so the client
 * never re-derives it.
 */

import { SKRIBBL_SETTINGS } from '../../../shared/standalone/skribbl/constants.js';
import type { SkribblSettings, UpdateSettingsRequest } from '../../../shared/standalone/skribbl/protocol.js';
import type { Members } from '../../platform/members.js';
import { refuse, succeed, type Outcome } from '../../platform/outcome.js';
import type { SkribblContext } from './skribblContext.js';

const clamp = (value: number, bounds: { min: number; max: number }): number =>
    Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));

/** Clamp, then snap to the nearest multiple of `step` (draw time moves in 15s steps). */
const clampToStep = (value: number, bounds: { min: number; max: number; step: number }): number =>
    clamp(bounds.min + Math.round((clamp(value, bounds) - bounds.min) / bounds.step) * bounds.step, bounds);

export class SkribblLobby {
    constructor(
        private readonly ctx: SkribblContext,
        private readonly members: Members
    ) {}

    get settings(): SkribblSettings {
        const { rounds, drawTimeSec, wordChoices, hints } = this.ctx.state.settings;
        return { rounds, drawTimeSec, wordChoices, hints };
    }

    /** Owner, in the lobby. Out-of-range values are clamped rather than refused. */
    updateSettings(playerId: string, update: UpdateSettingsRequest): Outcome<SkribblSettings> {
        const refused = this.requireOwnerInLobby(playerId);
        if (refused) return refused;
        const settings = this.ctx.state.settings;
        if (update.rounds !== undefined) settings.rounds = clamp(update.rounds, SKRIBBL_SETTINGS.ROUNDS);
        if (update.drawTimeSec !== undefined) settings.drawTimeSec = clampToStep(update.drawTimeSec, SKRIBBL_SETTINGS.DRAW_TIME_SEC);
        if (update.wordChoices !== undefined) settings.wordChoices = clamp(update.wordChoices, SKRIBBL_SETTINGS.WORD_CHOICES);
        if (update.hints !== undefined) settings.hints = clamp(update.hints, SKRIBBL_SETTINGS.HINTS);
        return succeed(this.settings);
    }

    /** May `playerId` start the game now? */
    checkStart(playerId: string): Outcome<null> {
        const refused = this.requireOwnerInLobby(playerId);
        if (refused) return refused;
        if (this.blockedReason() !== null) {
            return refuse('not_enough_players', `Need at least ${this.ctx.state.minPlayers} connected players.`);
        }
        return succeed(null);
    }

    /** Re-evaluate whether start is available. */
    refresh(): void {
        const blocked = this.blockedReason();
        this.ctx.state.blockedReason = blocked ?? '';
        this.ctx.state.canStart = this.ctx.state.phase === 'lobby' && blocked === null;
    }

    private blockedReason(): 'not_enough_players' | null {
        return this.members.active().length < this.ctx.state.minPlayers ? 'not_enough_players' : null;
    }

    private requireOwnerInLobby(playerId: string): Outcome<never> | null {
        if (!this.members.get(playerId)) return refuse('not_in_room', 'You are not in this room.');
        if (!this.members.isOwner(playerId)) return refuse('not_owner', 'Only the room owner can do that.');
        if (this.ctx.state.phase !== 'lobby') return refuse('wrong_phase', 'A game is already running.');
        return null;
    }
}
