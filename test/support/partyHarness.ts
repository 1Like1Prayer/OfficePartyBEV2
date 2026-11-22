/**
 * The party room's controllers wired together exactly as PartyRoom does, but
 * on a fake clock and without a server, so a whole competition can be played
 * in milliseconds.
 */

import { Lobby } from '../../src/server/rooms/party/lobby.js';
import { MatchFlow } from '../../src/server/rooms/party/matchFlow.js';
import { Members } from '../../src/server/platform/members.js';
import type { PartyContext } from '../../src/server/rooms/party/partyContext.js';
import { PartyState } from '../../src/server/rooms/party/schema/PartyState.js';
import { FakeScheduler } from './fakeScheduler.js';

export interface SentMessage {
    to: string | 'all';
    type: string;
    payload: unknown;
}

export const createPartyHarness = (playerIds: readonly string[]) => {
    const clock = new FakeScheduler();
    const sent: SentMessage[] = [];
    const ctx: PartyContext = {
        state: new PartyState(),
        scheduler: clock,
        broadcast: (type, payload) => sent.push({ to: 'all', type, payload }),
        sendTo: (to, type, payload) => sent.push({ to, type, payload })
    };
    const members = new Members(ctx);
    const lobby = new Lobby(ctx, members);
    const match = new MatchFlow(ctx, members, lobby);
    lobby.publishCatalogue();

    const join = (playerId: string) => {
        members.add(playerId, { name: playerId });
        match.onPlayerJoined(playerId);
        lobby.refresh();
    };
    playerIds.forEach(join);

    /** Messages of one type, newest last. */
    const messages = <T>(type: string): T[] =>
        sent.filter((message) => message.type === type).map((message) => message.payload as T);

    /** Everyone presses ready in the lobby. */
    const readyUp = () => {
        for (const id of playerIds) lobby.setReady(id, true);
    };

    /** Ready check -> start lead -> countdown, for the round being played. */
    const playToTiming = () => {
        const round = ctx.state.round;
        for (const id of round.participants) match.markReady(id, round.roundId, round.attempt);
        clock.advance(round.startAtMs! - clock.now());
        clock.advance(round.countdownMs);
    };

    return { clock, ctx, state: ctx.state, members, lobby, match, sent, join, messages, readyUp, playToTiming };
};
