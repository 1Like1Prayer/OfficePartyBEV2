/**
 * Who is in a room, and who owns it. Shared by every room type (the party
 * room and the standalone games), which each keep `players`, `ownerId` and
 * `phase` on their own synced state.
 *
 * - The room's creator owns it. Owner is a permissions role (pick games,
 *   press start, skip results); the owner doesn't run anything.
 * - When the owner drops or leaves, ownership moves to whoever has been
 *   connected longest. The match keeps running. If the room's creator
 *   dropped (a page refresh, a blip in the wifi) and comes back while their
 *   slot is held, they are given the room back.
 * - The owner may remove (kick) anyone else, in any phase.
 * - Joining during the lobby is free. Once a game is running, newcomers
 *   watch until the room is back in the lobby, unless the room lets them play
 *   straight away (`lateJoinersWatch: false`).
 */

import type { MapSchema } from '@colyseus/schema';
import { done, refuse, succeed, type Outcome } from './outcome.js';
import { sanitizeAvatar, sanitizeName } from './identity.js';
import { PlayerState } from './schema/PlayerState.js';

/** The part of a room's synced state that membership owns. */
export interface MembersState {
    players: MapSchema<PlayerState>;
    ownerId: string;
    /** The room's phase; 'lobby' is the only one newcomers join as players by default. */
    phase: string;
}

export interface MembersContext {
    readonly state: MembersState;
}

export interface MembersOptions {
    /** Newcomers who join mid-game watch until the lobby. Default true. */
    lateJoinersWatch?: boolean;
}

export interface JoinProfile {
    name?: unknown;
    avatar?: unknown;
}

export class Members {
    private joinCounter = 0;
    /** Who opened the room, while they still hold a slot in it. */
    private creatorId: string | null = null;

    private readonly lateJoinersWatch: boolean;

    constructor(
        private readonly ctx: MembersContext,
        options: MembersOptions = {}
    ) {
        this.lateJoinersWatch = options.lateJoinersWatch ?? true;
    }

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
            isSpectator: this.lateJoinersWatch && this.ctx.state.phase !== 'lobby',
            joinOrder: ++this.joinCounter
        });
        players.set(playerId, player);
        if (this.ctx.state.ownerId === '' && this.creatorId === null && players.size === 1) this.creatorId = playerId;
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
        if (this.ctx.state.ownerId === '') {
            this.claimOwnership(playerId);
        } else if (playerId === this.creatorId && !this.isOwner(playerId)) {
            // The creator is back: the room is theirs again. The stand-in keeps whatever ready they had.
            const standIn = this.get(this.ctx.state.ownerId);
            if (standIn) standIn.isOwner = false;
            this.claimOwnership(playerId);
        }
    }

    remove(playerId: string): void {
        if (!this.ctx.state.players.delete(playerId)) return;
        if (playerId === this.creatorId) this.creatorId = null;
        if (this.isOwner(playerId)) this.transferOwnership();
    }

    setName(playerId: string, raw: unknown): Outcome<{ name: string }> {
        const player = this.get(playerId);
        if (!player) return refuse('not_in_room', 'You are not in this room.');
        player.name = sanitizeName(raw, player.name);
        return succeed({ name: player.name });
    }

    /** May `ownerId` remove `targetId`? Only the owner, never themselves. */
    checkKick(ownerId: string, targetId: string): Outcome {
        if (!this.isOwner(ownerId)) return refuse('not_owner', 'Only the room owner can remove players.');
        if (targetId === ownerId) return refuse('invalid_target', 'You cannot remove yourself.');
        if (!this.get(targetId)) return refuse('invalid_target', 'That player is not in the room.');
        return done;
    }

    /**
     * Treat this player as the one who opened the room: they own it now, and
     * get it back after a dropped connection. A standalone game opened from
     * a party belongs to the party's owner, whoever's browser joins it first.
     */
    makeCreator(playerId: string): void {
        const player = this.get(playerId);
        if (!player) return;
        this.creatorId = playerId;
        if (this.isOwner(playerId) || !player.connected) return;
        const previous = this.get(this.ctx.state.ownerId);
        if (previous) previous.isOwner = false;
        this.claimOwnership(playerId);
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
