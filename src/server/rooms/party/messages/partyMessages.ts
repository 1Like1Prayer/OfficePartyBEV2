/**
 * Every message a client can send to a party room, as a Colyseus `messages`
 * map. Handlers are thin: validate, resolve the sender, call a controller,
 * and turn its Outcome into the request's reply.
 *
 * Requests (`room.request`) resolve with the returned value, or reject with
 * a `RequestError`. Progress is fire and forget.
 *
 * The map is left un-annotated so each handler keeps its own reply type, and
 * the SDK can type `room.request(...)` replies for the browser client.
 * Assigning it to `Room.messages` still type-checks every handler.
 */

import { validate, type Client, type MessageContext } from 'colyseus';
import {
    ClientMessage,
    ClientRequest,
    type PingReply
} from '../../../../shared/protocol.js';
import type { Outcome } from '../../../platform/outcome.js';
import type { Scheduler } from '../../../platform/scheduler.js';
import type { Lobby } from '../lobby.js';
import type { MatchFlow } from '../matchFlow.js';
import type { Members } from '../members.js';
import {
    kickPlayerRequest,
    progressMessage,
    roundActionRequest,
    setModeRequest,
    setNameRequest,
    setReadyRequest,
    submitResultRequest,
    roundEnvelope
} from './validators.js';

/**
 * What a handler's `this` needs. PartyRoom provides it; naming the room type
 * itself here would make the room's type depend on its own messages.
 */
interface PartyHandlerScope {
    readonly scheduler: Scheduler;
    readonly members: Members;
    readonly lobby: Lobby;
    readonly match: MatchFlow;
    kickPlayer(ownerId: string, targetId: string): Outcome;
}

/** Resolve the request with the outcome's value, or reject it with its error. */
const reply = <T>(ctx: MessageContext, outcome: Outcome<T>) =>
    outcome.ok ? outcome.value : ctx.reject(outcome.error);

export const partyMessages = {
    [ClientRequest.Ping](this: PartyHandlerScope): PingReply {
        return { serverTimeMs: this.scheduler.now() };
    },

    [ClientRequest.SetName]: validate(setNameRequest, function (this: PartyHandlerScope, client, message, ctx) {
        return reply(ctx, this.members.setName(client.sessionId, message.name));
    }),

    [ClientRequest.SetMode]: validate(setModeRequest, function (this: PartyHandlerScope, client, message, ctx) {
        return reply(ctx, this.lobby.setMode(client.sessionId, message.mode, message.gameIds));
    }),

    [ClientRequest.SetReady]: validate(setReadyRequest, function (this: PartyHandlerScope, client, message, ctx) {
        return reply(ctx, this.lobby.setReady(client.sessionId, message.ready));
    }),

    [ClientRequest.StartCompetition](this: PartyHandlerScope, client: Client, _message: unknown, ctx: MessageContext) {
        return reply(ctx, this.match.start(client.sessionId));
    },

    [ClientRequest.SkipResults](this: PartyHandlerScope, client: Client, _message: unknown, ctx: MessageContext) {
        return reply(ctx, this.match.skipResults(client.sessionId));
    },

    [ClientRequest.SkipGame](this: PartyHandlerScope, client: Client, _message: unknown, ctx: MessageContext) {
        return reply(ctx, this.match.skipGame(client.sessionId));
    },

    [ClientRequest.ReturnToLobby](this: PartyHandlerScope, client: Client, _message: unknown, ctx: MessageContext) {
        return reply(ctx, this.match.backToLobby(client.sessionId));
    },

    [ClientRequest.KickPlayer]: validate(kickPlayerRequest, function (this: PartyHandlerScope, client, message, ctx) {
        return reply(ctx, this.kickPlayer(client.sessionId, message.playerId));
    }),

    [ClientRequest.ReadyForRound]: validate(roundEnvelope, function (this: PartyHandlerScope, client, message, ctx) {
        return reply(ctx, this.match.markReady(client.sessionId, message.roundId, message.attempt));
    }),

    [ClientRequest.SubmitResult]: validate(submitResultRequest, function (this: PartyHandlerScope, client, message, ctx) {
        const { roundId, attempt, result } = message;
        return reply(ctx, this.match.submitResult(client.sessionId, roundId, attempt, result));
    }),

    [ClientRequest.RoundAction]: validate(roundActionRequest, function (this: PartyHandlerScope, client, message, ctx) {
        const { roundId, attempt, action } = message;
        return reply(ctx, this.match.handleAction(client.sessionId, roundId, attempt, action));
    }),

    [ClientMessage.Progress](this: PartyHandlerScope, client: Client, message: unknown) {
        const parsed = progressMessage.safeParse(message);
        if (!parsed.success) return;
        const { roundId, attempt, progress } = parsed.data;
        this.match.submitProgress(client.sessionId, roundId, attempt, progress);
    }
};
