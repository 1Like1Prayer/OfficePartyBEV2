/**
 * Who is in the room, and who owns it.
 *
 * - The room's creator owns it. Owner is a permissions role (pick games,
 *   press start, skip results); the owner doesn't run anything.
 * - When the owner drops or leaves, ownership moves to whoever has been
 *   connected longest. The match keeps running.
 * - Joining during the lobby is free; once a competition is running,
 *   newcomers watch until the room is back in the lobby.
 */

import { refuse, succeed, type Outcome } from '../../platform/outcome.js';
import { sanitizeAvatar, sanitizeName } from '../../platform/identity.js';
import type { PartyContext } from './partyContext.js';
import { PlayerState } from './schema/PlayerState.js';

export interface JoinProfile {
    name?: unknown;
    avatar?: unknown;
}

export class Members {
    private joinCounter = 0;

    constructor(private readonly ctx: PartyContext) {}

    get(playerId: string): PlayerState | undefined {
        return this.ctx.state.players.get(playerId);
    }

    isOwner(playerId: string): boolean {
        return this.ctx.state.ownerId === playerId;
    }

    /** Connected players taking part (not watching), in join order. */
    active(): PlayerState[] {
        return this.inJoinOrder().filter((player) => player.connected && !player.isSpectator);
    }

    hasConnectedPlayers(): boolean {
        return this.inJoinOrder().some((player) => player.connected);
    }

    add(playerId: string, profile: JoinProfile): PlayerState {
        const players = this.ctx.state.players;
        const player = new PlayerState({
            id: playerId,
            name: sanitizeName(profile.name, `Player ${players.size + 1}`),
            // The id is a fine fallback seed: stable, and unique per player.
            avatar: sanitizeAvatar(profile.avatar, playerId),
            isSpectator: this.ctx.state.phase !== 'lobby',
            joinOrder: ++this.joinCounter
        });
        players.set(playerId, player);
        if (this.ctx.state.ownerId === '') this.claimOwnership(playerId);
        return player;
    }

    /** The connection dropped; the slot is held while Colyseus waits for a reconnect. */
    markDisconnected(playerId: string): void {
        const player = this.get(playerId);
        if (!player) return;
        player.connected = false;
        if (this.isOwner(playerId)) this.transferOwnership();
    }

    markReconnected(playerId: string): void {
        const player = this.get(playerId);
        if (!player) return;
        player.connected = true;
        if (this.ctx.state.ownerId === '') this.claimOwnership(playerId);
    }

    remove(playerId: string): void {
        if (!this.ctx.state.players.delete(playerId)) return;
        if (this.isOwner(playerId)) this.transferOwnership();
    }

    setName(playerId: string, raw: unknown): Outcome<{ name: string }> {
        const player = this.get(playerId);
        if (!player) return refuse('not_in_room', 'You are not in this room.');
        player.name = sanitizeName(raw, player.name);
        return succeed({ name: player.name });
    }

    /** Back in the lobby: spectators play again and everyone re-confirms. */
    resetForLobby(): void {
        for (const player of this.ctx.state.players.values()) {
            player.isSpectator = false;
            player.ready = this.isOwner(player.id);
        }
    }

    /** Mirror the competition's score table onto the players. */
    applyPoints(pointsOf: (playerId: string) => number): void {
        for (const player of this.ctx.state.players.values()) {
            player.points = pointsOf(player.id);
        }
    }

    private transferOwnership(): void {
        const next = this.inJoinOrder().find(
            (player) => player.connected && !this.isOwner(player.id)
        );
        const previous = this.get(this.ctx.state.ownerId);
        if (previous) previous.isOwner = false;
        this.ctx.state.ownerId = '';
        if (next) this.claimOwnership(next.id);
    }

    /**
     * The owner is ready by definition: they hold the start button, so there
     * is nothing for them to signal, and an unready owner could never start.
     */
    private claimOwnership(playerId: string): void {
        const owner = this.get(playerId);
        if (!owner) return;
        this.ctx.state.ownerId = playerId;
        owner.isOwner = true;
        owner.ready = true;
    }

    private inJoinOrder(): PlayerState[] {
        return [...this.ctx.state.players.values()].sort((a, b) => a.joinOrder - b.joinOrder);
    }
}
