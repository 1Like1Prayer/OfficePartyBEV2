/**
 * Every request a client can send to a Skribbl room, as a Colyseus
 * `messages` map. Handlers are thin: validate, call a controller, turn its
 * Outcome into the request's reply.
 *
 * Renaming, kicking and clock pings use the party room's message names, so
 * the client shares that code between rooms.
 */

import { validate, type Client, type MessageContext } from 'colyseus';
import { ClientRequest, type PingReply } from '../../../../shared/protocol.js';
import { SkribblRequest } from '../../../../shared/standalone/skribbl/protocol.js';
import type { Members } from '../../../platform/members.js';
import type { Outcome } from '../../../platform/outcome.js';
import type { Scheduler } from '../../../platform/scheduler.js';
import { kickPlayerRequest, setNameRequest } from '../../party/messages/validators.js';
import type { SkribblGame } from '../game.js';
import type { SkribblLobby } from '../lobby.js';
import { chooseWordRequest, sayRequest, updateSettingsRequest } from './validators.js';

/** What a handler's `this` needs. SkribblRoom provides it. */
interface SkribblHandlerScope {
    readonly scheduler: Scheduler;
    readonly members: Members;
    readonly lobby: SkribblLobby;
    readonly game: SkribblGame;
    kickPlayer(ownerId: string, targetId: string): Outcome;
}

const reply = <T>(ctx: MessageContext, outcome: Outcome<T>) =>
    outcome.ok ? outcome.value : ctx.reject(outcome.error);

export const skribblMessages = {
    [ClientRequest.Ping](this: SkribblHandlerScope): PingReply {
        return { serverTimeMs: this.scheduler.now() };
    },

    [ClientRequest.SetName]: validate(setNameRequest, function (this: SkribblHandlerScope, client, message, ctx) {
        return reply(ctx, this.members.setName(client.sessionId, message.name));
    }),

    [ClientRequest.KickPlayer]: validate(kickPlayerRequest, function (this: SkribblHandlerScope, client, message, ctx) {
        return reply(ctx, this.kickPlayer(client.sessionId, message.playerId));
    }),

    [SkribblRequest.UpdateSettings]: validate(updateSettingsRequest, function (this: SkribblHandlerScope, client, message, ctx) {
        return reply(ctx, this.lobby.updateSettings(client.sessionId, message));
    }),

    [SkribblRequest.Start](this: SkribblHandlerScope, client: Client, _message: unknown, ctx: MessageContext) {
        return reply(ctx, this.game.start(client.sessionId));
    },

    [SkribblRequest.ReturnToLobby](this: SkribblHandlerScope, client: Client, _message: unknown, ctx: MessageContext) {
        return reply(ctx, this.game.returnToLobby(client.sessionId));
    },

    [SkribblRequest.ChooseWord]: validate(chooseWordRequest, function (this: SkribblHandlerScope, client, message, ctx) {
        return reply(ctx, this.game.chooseWord(client.sessionId, message.turnId, message.index));
    }),

    [SkribblRequest.Say]: validate(sayRequest, function (this: SkribblHandlerScope, client, message, ctx) {
        return reply(ctx, this.game.say(client.sessionId, message.text));
    })
};

/*
 * Draw packets arrive with `room.sendBytes`, which Colyseus routes apart from
 * this map: SkribblRoom registers them with `onMessageBytes(SkribblBytes.Draw, …)`.
 */
