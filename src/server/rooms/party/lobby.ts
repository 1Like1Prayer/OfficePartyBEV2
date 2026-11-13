/**
 * The lobby: the owner picks a playlist mode, everyone presses ready, the
 * owner starts. The start rules are evaluated here and published in
 * `state.lobby`, so the client never re-derives them.
 */

import { ROOM } from '../../../shared/constants.js';
import type { GameId } from '../../../shared/games/catalog.js';
import type { PlaylistMode, StartBlockedReason } from '../../../shared/protocol.js';
import { buildCustomPlaylist, buildRandomPlaylist } from '../../competition/playlist.js';
import { playableGameIds, roundsForGame } from '../../games/registry.js';
import { refuse, succeed, type Outcome } from '../../platform/outcome.js';
import type { Members } from './members.js';
import type { PartyContext } from './partyContext.js';
import { replaceArray, replaceMap } from './schema/sync.js';

export class Lobby {
    private customPlaylist: GameId[] = [];

    constructor(
        private readonly ctx: PartyContext,
        private readonly members: Members
    ) {}

    /** Publish the catalogue the owner picks from. Called once, on room creation. */
    publishCatalogue(): void {
        const playable = playableGameIds();
        replaceArray(this.ctx.state.lobby.playableGames, playable);
        replaceMap(
            this.ctx.state.lobby.roundsByGame,
            Object.fromEntries(playable.map((id) => [id, roundsForGame(id)]))
        );
        this.refresh();
    }

    setMode(
        playerId: string,
        mode: PlaylistMode,
        gameIds: readonly GameId[] = []
    ): Outcome<{ mode: PlaylistMode; playlist: GameId[] }> {
        const refused = this.requireOwnerInLobby(playerId);
        if (refused) return refused;

        if (mode === 'custom') {
            const built = buildCustomPlaylist(gameIds);
            if (!built.ok) return refuse('invalid_playlist', built.message);
            this.customPlaylist = built.playlist;
        } else {
            this.customPlaylist = [];
        }
        this.ctx.state.lobby.mode = mode;
        replaceArray(this.ctx.state.lobby.customPlaylist, this.customPlaylist);
        this.refresh();
        return succeed({ mode, playlist: [...this.customPlaylist] });
    }

    /** Toggle a player's lobby ready flag. The owner is always ready. */
    setReady(playerId: string, ready: boolean): Outcome<{ ready: boolean }> {
        const player = this.members.get(playerId);
        if (!player) return refuse('not_in_room', 'You are not in this room.');
        if (this.ctx.state.phase !== 'lobby') {
            return refuse('wrong_phase', 'Ready only applies in the lobby.');
        }
        player.ready = this.members.isOwner(playerId) || ready;
        this.refresh();
        return succeed({ ready: player.ready });
    }

    /** Check the owner may start now, and build the playlist they will play. */
    preparePlaylist(playerId: string): Outcome<GameId[]> {
        const refused = this.requireOwnerInLobby(playerId);
        if (refused) return refused;

        const blocked = this.blockedReason();
        if (blocked === 'not_enough_players') {
            return refuse(blocked, `Need at least ${ROOM.MIN_PLAYERS} connected players.`);
        }
        if (blocked === 'players_not_ready') {
            const names = this.members.active().filter((p) => !p.ready).map((p) => p.name);
            return refuse(blocked, `Waiting on ${names.join(', ')}.`);
        }
        const playlist =
            this.ctx.state.lobby.mode === 'custom' ? [...this.customPlaylist] : buildRandomPlaylist();
        if (playlist.length === 0) {
            return refuse('invalid_playlist', 'No playable games are available.');
        }
        return succeed(playlist);
    }

    /** Re-evaluate who the lobby waits on and whether start is available. */
    refresh(): void {
        const lobby = this.ctx.state.lobby;
        const blocked = this.blockedReason();
        replaceArray(
            lobby.waitingFor,
            this.members.active().filter((p) => !p.ready).map((p) => p.id)
        );
        lobby.blockedReason = blocked ?? '';
        lobby.canStart = this.ctx.state.phase === 'lobby' && blocked === null;
    }

    private blockedReason(): StartBlockedReason | null {
        const active = this.members.active();
        if (active.length < ROOM.MIN_PLAYERS) return 'not_enough_players';
        // A player holding a disconnected slot does not block the room.
        if (active.some((player) => !player.ready)) return 'players_not_ready';
        const custom = this.ctx.state.lobby.mode === 'custom';
        if ((custom ? this.customPlaylist : playableGameIds()).length === 0) return 'invalid_playlist';
        return null;
    }

    private requireOwnerInLobby(playerId: string): Outcome<never> | null {
        if (!this.members.get(playerId)) return refuse('not_in_room', 'You are not in this room.');
        if (!this.members.isOwner(playerId)) return refuse('not_owner', 'Only the room owner can do that.');
        if (this.ctx.state.phase !== 'lobby') {
            return refuse('competition_in_progress', 'A competition is already running.');
        }
        return null;
    }
}
