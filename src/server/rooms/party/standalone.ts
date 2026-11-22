/**
 * Standalone games, opened from the party lobby. The owner picks one; the
 * server creates that game's own room and publishes its code in
 * `state.standalone`, and every client in the party moves into it while
 * keeping its seat here. Leaving the game brings a player back to this lobby.
 *
 * The owner gets a one-off token with the code, so they own the game room
 * too, whoever's browser gets there first.
 */

import { randomBytes } from 'node:crypto';
import type { LaunchStandaloneReply } from '../../../shared/protocol.js';
import { STANDALONE_CATALOG, type StandaloneGameId } from '../../../shared/standalone/catalog.js';
import type { Members } from '../../platform/members.js';
import { refuse, succeed, type Outcome } from '../../platform/outcome.js';
import type { StandaloneCreateOptions } from '../../platform/standaloneLink.js';
import type { PartyContext } from './partyContext.js';

/** The matchmaker, as far as this needs it; a test passes fakes. */
export interface StandaloneRooms {
    /** Create a room and return its code. */
    create(roomName: string, options: StandaloneCreateOptions): Promise<string>;
    exists(roomCode: string): Promise<boolean>;
}

export class StandaloneLauncher {
    private launching = false;

    constructor(
        private readonly ctx: PartyContext,
        private readonly members: Members,
        private readonly rooms: StandaloneRooms
    ) {}

    async launch(playerId: string, gameId: StandaloneGameId): Promise<Outcome<LaunchStandaloneReply>> {
        const state = this.ctx.state;
        if (!this.members.get(playerId)) return refuse('not_in_room', 'You are not in this room.');
        if (!this.members.isOwner(playerId)) return refuse('not_owner', 'Only the room owner can pick a game.');
        if (state.phase !== 'lobby') return refuse('wrong_phase', 'Finish the run first.');
        const meta = STANDALONE_CATALOG[gameId];
        if (!meta.implemented) return refuse('invalid_payload', 'That game is not ready yet.');
        if (this.launching) return refuse('wrong_phase', 'A game is already being opened.');

        this.launching = true;
        try {
            const running = state.standalone.roomCode;
            if (running !== '' && (await this.rooms.exists(running))) {
                return refuse('wrong_phase', 'A game is already open. Join it from the lobby.');
            }
            const ownerToken = randomBytes(12).toString('hex');
            const roomCode = await this.rooms.create(meta.roomName, { partyCode: state.roomCode, ownerToken });
            state.standalone.gameId = gameId;
            state.standalone.roomCode = roomCode;
            return succeed({ roomCode, ownerToken });
        } finally {
            this.launching = false;
        }
    }

    /** The game's room closed (everyone left it): the lobby stops offering it. */
    onClosed(roomCode: string): void {
        const link = this.ctx.state.standalone;
        if (link.roomCode !== roomCode) return;
        link.gameId = '';
        link.roomCode = '';
    }
}
