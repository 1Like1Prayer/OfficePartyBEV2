/**
 * A Skribbl game without a server: the real controllers on a fake clock,
 * with every message recorded.
 */

import { Members } from '../../src/server/platform/members.js';
import { SkribblGame } from '../../src/server/rooms/skribbl/game.js';
import { SkribblLobby } from '../../src/server/rooms/skribbl/lobby.js';
import { SkribblState } from '../../src/server/rooms/skribbl/schema/SkribblState.js';
import type { SkribblContext } from '../../src/server/rooms/skribbl/skribblContext.js';
import { WordBank } from '../../src/server/standalone/skribbl/wordBank.js';
import { FakeScheduler } from './fakeScheduler.js';

export interface Sent {
    to: string;
    type: string;
    payload: unknown;
    /** For binary messages: who it was not sent to. */
    except?: string;
}

/** Always picks the first option, so tests know which word comes up. */
const first = () => 0;

export const createSkribblHarness = (playerIds: readonly string[], words = ['polar bear', 'cat', 'elephant', 'T-rex', 'apple', 'lemon']) => {
    const clock = new FakeScheduler();
    const sent: Sent[] = [];
    const ctx: SkribblContext = {
        state: new SkribblState(),
        scheduler: clock,
        randomInt: first,
        broadcast: (type, payload) => sent.push({ to: 'all', type, payload }),
        sendTo: (to, type, payload) => sent.push({ to, type, payload }),
        broadcastBytes: (type, bytes, except) => sent.push({ to: 'all', type, payload: bytes, except }),
        sendBytesTo: (to, type, bytes) => sent.push({ to, type, payload: bytes })
    };
    const members = new Members(ctx, { lateJoinersWatch: false });
    const lobby = new SkribblLobby(ctx, members);
    const game = new SkribblGame(ctx, members, lobby, new WordBank(words, first));

    const join = (playerId: string) => {
        members.add(playerId, { name: playerId });
        game.onPlayerJoined(playerId);
        lobby.refresh();
    };
    const leave = (playerId: string) => {
        members.remove(playerId);
        game.onPlayerLeft(playerId);
        lobby.refresh();
    };
    const drop = (playerId: string) => {
        members.markDisconnected(playerId);
        game.onPlayerDropped(playerId);
        lobby.refresh();
    };
    const reconnect = (playerId: string) => {
        members.markReconnected(playerId);
        game.onPlayerReconnected(playerId);
        lobby.refresh();
    };
    playerIds.forEach(join);

    const messagesTo = (playerId: string, type: string) =>
        sent.filter((m) => m.type === type && (m.to === playerId || (m.to === 'all' && m.except !== playerId)));

    return { clock, sent, ctx, state: ctx.state, members, lobby, game, join, leave, drop, reconnect, messagesTo };
};
