/**
 * The party room: one per group of players, joined with a 4-character code.
 *
 * A thin Colyseus adapter. It maps the room lifecycle onto three
 * framework-light controllers and does nothing else:
 *
 * - Members:   who is here, owner succession
 * - Lobby:     playlist mode, ready flags, start rules
 * - MatchFlow: the competition and the round being played
 *
 * Colyseus provides the rest: schema state sync, reconnection
 * (`allowReconnection`), request/reply, validation and message rate limits.
 */

import { matchMaker, Room, ServerError, type AuthContext, type Client } from 'colyseus';
import { PROTOCOL_VERSION, ROOM } from '../../../shared/constants.js';
import { PROTOCOL_MISMATCH_CODE, type JoinOptions } from '../../../shared/protocol.js';
import { uniqueRoomCode } from '../../platform/identity.js';
import { createRoomScheduler, createRoomTimeline, type Scheduler } from '../../platform/scheduler.js';
import { Lobby } from './lobby.js';
import { MatchFlow } from './matchFlow.js';
import { Members } from './members.js';
import { partyMessages } from './messages/partyMessages.js';
import { joinOptions } from './messages/validators.js';
import type { PartyContext } from './partyContext.js';
import { PartyState } from './schema/PartyState.js';

/** Close code for join options that fail validation. */
const INVALID_JOIN_OPTIONS_CODE = 4101;

export class PartyRoom extends Room<{ state: PartyState }> {
    override maxClients = ROOM.MAX_PLAYERS;
    override maxMessagesPerSecond = ROOM.MAX_MESSAGES_PER_SECOND;
    override state = new PartyState();
    override messages = partyMessages;

    /** The room timeline starts now, so every server-stamped time is "ms since creation". */
    readonly scheduler: Scheduler = createRoomScheduler(this.clock, createRoomTimeline());

    private readonly context: PartyContext = {
        state: this.state,
        scheduler: this.scheduler,
        broadcast: (type, payload) => this.broadcast(type, payload, { afterNextPatch: true }),
        sendTo: (playerId, type, payload) =>
            this.clients.get(playerId)?.send(type, payload, { afterNextPatch: true })
    };

    readonly members = new Members(this.context);
    readonly lobby = new Lobby(this.context, this.members);
    readonly match = new MatchFlow(this.context, this.members, this.lobby);

    override async onCreate(): Promise<void> {
        // The short code doubles as the Colyseus roomId, so `joinById(code)` just works.
        this.roomId = await uniqueRoomCode(
            async (code) => (await matchMaker.query({ roomId: code })).length > 0
        );
        this.state.roomCode = this.roomId;
        // Rooms are joined by code only, never listed or matched at random.
        await this.setPrivate(true);
        this.lobby.publishCatalogue();
    }

    /**
     * Client and server ship separately, and with game logic in the browser a
     * stale client runs different rules: refuse it at the door with a code the
     * client turns into "please reload".
     */
    override onAuth(_client: Client, options: unknown, _context: AuthContext): JoinOptions {
        const parsed = joinOptions.safeParse(options ?? {});
        if (!parsed.success) throw new ServerError(INVALID_JOIN_OPTIONS_CODE, 'Bad join options.');
        if (parsed.data.protocolVersion !== PROTOCOL_VERSION) {
            throw new ServerError(PROTOCOL_MISMATCH_CODE, 'Please reload to get the current version.');
        }
        return parsed.data;
    }

    override onJoin(client: Client, _options: unknown, auth: JoinOptions): void {
        this.members.add(client.sessionId, auth);
        this.match.onPlayerJoined(client.sessionId);
        this.lobby.refresh();
    }

    /** The socket dropped: hold the slot, and stop the round waiting on them right away. */
    override onDrop(client: Client): void {
        this.members.markDisconnected(client.sessionId);
        this.match.onPlayerGone(client.sessionId);
        this.lobby.refresh();
        // It rejects when the grace runs out or the room disposes first; Colyseus
        // then calls onLeave, which is where that case is handled.
        this.allowReconnection(client, ROOM.DISCONNECT_GRACE_SECONDS).catch(() => undefined);
    }

    override onReconnect(client: Client): void {
        this.members.markReconnected(client.sessionId);
        this.match.onPlayerReconnected(client.sessionId);
        this.lobby.refresh();
    }

    /** An explicit leave, or the grace period ran out. */
    override onLeave(client: Client): void {
        this.members.remove(client.sessionId);
        this.match.onPlayerGone(client.sessionId);
        this.lobby.refresh();
    }

    override onDispose(): void {
        this.match.dispose();
    }
}
