/**
 * The Skribbl room: a standalone game, joined with a 4-character code exactly
 * like a party room. A thin Colyseus adapter over three controllers:
 *
 * - Members:      who is here, owner succession (shared with the party room)
 * - SkribblLobby: settings and the start rule
 * - SkribblGame:  turns, the secret word, guesses, scoring and the drawing
 *
 * Unlike the party room, a player who joins mid-game plays straight away as a
 * guesser, and draws from the next round.
 */

import { matchMaker, Room, ServerError, type AuthContext, type Client, type Deferred } from 'colyseus';
import { PROTOCOL_VERSION, ROOM } from '../../../shared/constants.js';
import { KICKED_CODE, PROTOCOL_MISMATCH_CODE, type JoinOptions } from '../../../shared/protocol.js';
import { STANDALONE_CATALOG } from '../../../shared/standalone/catalog.js';
import { SKRIBBL_MAX_MESSAGES_PER_SECOND } from '../../../shared/standalone/skribbl/constants.js';
import { SkribblBytes } from '../../../shared/standalone/skribbl/protocol.js';
import { uniqueRoomCode } from '../../platform/identity.js';
import { Members } from '../../platform/members.js';
import { readStandaloneCreateOptions, standaloneClosedTopic } from '../../platform/standaloneLink.js';
import type { Outcome } from '../../platform/outcome.js';
import { createRoomScheduler, createRoomTimeline, type Scheduler } from '../../platform/scheduler.js';
import { secureRandomInt } from '../../standalone/skribbl/wordBank.js';
import { joinOptions } from '../party/messages/validators.js';
import { SkribblGame } from './game.js';
import { SkribblLobby } from './lobby.js';
import { skribblMessages } from './messages/skribblMessages.js';
import { SkribblState } from './schema/SkribblState.js';
import type { SkribblContext } from './skribblContext.js';

/** Close code for join options that fail validation (same as the party room). */
const INVALID_JOIN_OPTIONS_CODE = 4101;

export class SkribblRoom extends Room<{ state: SkribblState }> {
    override maxClients = STANDALONE_CATALOG.skribbl.maxPlayers;
    override maxMessagesPerSecond = SKRIBBL_MAX_MESSAGES_PER_SECOND;
    override state = new SkribblState();
    override messages = skribblMessages;

    /** The room timeline starts now, so every server-stamped time is "ms since creation". */
    readonly scheduler: Scheduler = createRoomScheduler(this.clock, createRoomTimeline());

    private readonly context: SkribblContext = {
        state: this.state,
        scheduler: this.scheduler,
        randomInt: secureRandomInt,
        broadcast: (type, payload) => this.broadcast(type, payload, { afterNextPatch: true }),
        sendTo: (playerId, type, payload) =>
            this.clients.getById(playerId)?.send(type, payload, { afterNextPatch: true }),
        // Live strokes go out at once: clients match them to a turn by its id, not by phase.
        broadcastBytes: (type, bytes, exceptId) => {
            const except = this.clients.getById(exceptId);
            this.broadcastBytes(type, bytes, except ? { except } : {});
        },
        // A catch-up snapshot follows the state patch, so the client knows the turn first.
        sendBytesTo: (playerId, type, bytes) =>
            this.clients.getById(playerId)?.sendBytes(type, bytes, { afterNextPatch: true })
    };

    readonly members = new Members(this.context, { lateJoinersWatch: false });
    readonly lobby = new SkribblLobby(this.context, this.members);
    readonly game = new SkribblGame(this.context, this.members, this.lobby);

    private readonly pendingReconnections = new Map<string, Deferred<Client>>();
    private readonly kicked = new Set<string>();
    /** Set when a party room opened this one: that party, and its owner's token. */
    private partyCode: string | undefined;
    private ownerToken: string | undefined;

    override async onCreate(options: unknown): Promise<void> {
        ({ partyCode: this.partyCode, ownerToken: this.ownerToken } = readStandaloneCreateOptions(options));
        // Codes are unique across every room type, so a code always means one room.
        this.roomId = await uniqueRoomCode(
            async (code) => (await matchMaker.query({ roomId: code })).length > 0
        );
        this.state.roomCode = this.roomId;
        await this.setPrivate(true);
        // Raw bytes from `room.sendBytes` bypass the `messages` map. A bad packet is dropped, never a disconnect.
        this.onMessageBytes(SkribblBytes.Draw, (client: Client, message: Uint8Array) => {
            if (message instanceof Uint8Array) this.game.draw(client.sessionId, message);
        });
        this.lobby.refresh();
    }

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
        if (this.ownerToken !== undefined && auth.ownerToken === this.ownerToken) {
            this.members.makeCreator(client.sessionId);
        }
        this.game.onPlayerJoined(client.sessionId);
        this.lobby.refresh();
    }

    override onDrop(client: Client): void {
        if (this.kicked.has(client.sessionId)) return;
        this.members.markDisconnected(client.sessionId);
        this.game.onPlayerDropped(client.sessionId);
        this.lobby.refresh();
        const reconnection = this.allowReconnection(client, ROOM.DISCONNECT_GRACE_SECONDS);
        this.pendingReconnections.set(client.sessionId, reconnection);
        reconnection
            .catch(() => undefined)
            .finally(() => this.pendingReconnections.delete(client.sessionId));
    }

    override onReconnect(client: Client): void {
        this.members.markReconnected(client.sessionId);
        this.game.onPlayerReconnected(client.sessionId);
        this.lobby.refresh();
    }

    override onLeave(client: Client): void {
        this.kicked.delete(client.sessionId);
        this.members.remove(client.sessionId);
        this.game.onPlayerLeft(client.sessionId);
        this.lobby.refresh();
    }

    /** Owner removes a player; onLeave does the bookkeeping, as for a player who left. */
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
        this.game.dispose();
        // Tell the party that opened this room that it is gone.
        if (this.partyCode !== undefined) {
            void matchMaker.presence.publish(standaloneClosedTopic(this.partyCode), this.roomId);
        }
    }
}
