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

import { matchMaker, Room, ServerError, type AuthContext, type Client, type Deferred } from 'colyseus';
import { PROTOCOL_VERSION, ROOM } from '../../../shared/constants.js';
import { KICKED_CODE, PROTOCOL_MISMATCH_CODE, type JoinOptions } from '../../../shared/protocol.js';
import { uniqueRoomCode } from '../../platform/identity.js';
import type { Outcome } from '../../platform/outcome.js';
import { createRoomScheduler, createRoomTimeline, type Scheduler } from '../../platform/scheduler.js';
import { Lobby } from './lobby.js';
import { MatchFlow } from './matchFlow.js';
import { Members } from '../../platform/members.js';
import { standaloneClosedTopic } from '../../platform/standaloneLink.js';
import { StandaloneLauncher } from './standalone.js';
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
    readonly standalone = new StandaloneLauncher(this.context, this.members, {
        create: async (roomName, options) => (await matchMaker.createRoom(roomName, options)).roomId,
        exists: async (roomCode) => (await matchMaker.query({ roomId: roomCode })).length > 0
    });

    private readonly onStandaloneClosed = (roomCode: unknown): void => {
        if (typeof roomCode === 'string') this.standalone.onClosed(roomCode);
    };

    /** Dropped players' held slots, so a kick can cancel the wait. */
    private readonly pendingReconnections = new Map<string, Deferred<Client>>();
    /** Kicked players whose socket is still closing: their drop is a leave. */
    private readonly kicked = new Set<string>();

    override async onCreate(): Promise<void> {
        // The short code doubles as the Colyseus roomId, so `joinById(code)` just works.
        this.roomId = await uniqueRoomCode(
            async (code) => (await matchMaker.query({ roomId: code })).length > 0
        );
        this.state.roomCode = this.roomId;
        // Rooms are joined by code only, never listed or matched at random.
        await this.setPrivate(true);
        this.lobby.publishCatalogue();
        await matchMaker.presence.subscribe(standaloneClosedTopic(this.roomId), this.onStandaloneClosed);
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
        // A kick closes the socket with a non-consented code; Colyseus calls
        // onLeave right after an onDrop that holds no slot.
        if (this.kicked.has(client.sessionId)) return;
        this.members.markDisconnected(client.sessionId);
        this.match.onPlayerGone(client.sessionId);
        this.lobby.refresh();
        // It rejects when the grace runs out or the room disposes first; Colyseus
        // then calls onLeave, which is where that case is handled.
        const reconnection = this.allowReconnection(client, ROOM.DISCONNECT_GRACE_SECONDS);
        this.pendingReconnections.set(client.sessionId, reconnection);
        reconnection
            .catch(() => undefined)
            .finally(() => this.pendingReconnections.delete(client.sessionId));
    }

    override onReconnect(client: Client): void {
        this.members.markReconnected(client.sessionId);
        this.match.onPlayerReconnected(client.sessionId);
        this.lobby.refresh();
    }

    /** An explicit leave, or the grace period ran out. */
    override onLeave(client: Client): void {
        this.kicked.delete(client.sessionId);
        this.members.remove(client.sessionId);
        this.match.onPlayerGone(client.sessionId);
        this.lobby.refresh();
    }

    /**
     * Owner removes a player. A connected player is disconnected with
     * KICKED_CODE; a dropped one loses their held slot. Either way onLeave
     * does the bookkeeping, exactly as for a player who left.
     */
    kickPlayer(ownerId: string, targetId: string): Outcome {
        const allowed = this.members.checkKick(ownerId, targetId);
        if (!allowed.ok) return allowed;
        this.kicked.add(targetId);
        const client = this.clients.getById(targetId);
        if (client) {
            client.leave(KICKED_CODE, 'Removed by the room owner.');
        } else {
            this.pendingReconnections.get(targetId)?.reject(new Error('kicked'));
        }
        return allowed;
    }

    override onDispose(): void {
        this.match.dispose();
        void matchMaker.presence.unsubscribe(standaloneClosedTopic(this.roomId), this.onStandaloneClosed);
    }
}
