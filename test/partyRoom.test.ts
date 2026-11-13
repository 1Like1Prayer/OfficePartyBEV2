/**
 * The party room against a real Colyseus server: joining by code, the
 * protocol check, lobby requests, clock pings and state sync.
 *
 * Round timing is covered by the fake-clock tests in test/matchFlow.test.ts.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { boot, type ColyseusTestServer } from '@colyseus/testing';
import appConfig from '../src/app.config.js';
import { PROTOCOL_VERSION, ROOM } from '../src/shared/constants.js';
import {
    ClientRequest,
    PARTY_ROOM_NAME,
    PROTOCOL_MISMATCH_CODE,
    type SetModeReply
} from '../src/shared/protocol.js';
import type { PartyRoom } from '../src/server/rooms/party/PartyRoom.js';

const join = { protocolVersion: PROTOCOL_VERSION };

/** A refused request rejects with an Error whose `reason` is the RequestError. */
const refusedWith = (code: string) => (error: { reason?: { code?: string } }) =>
    error.reason?.code === code;

describe('party room', () => {
    let colyseus: ColyseusTestServer<typeof appConfig>;

    before(async () => {
        colyseus = await boot(appConfig);
    });
    after(async () => colyseus.shutdown());
    beforeEach(async () => colyseus.cleanup());

    const createParty = async (name = 'Host') => {
        const room = await colyseus.createRoom<PartyRoom>(PARTY_ROOM_NAME, {});
        const host = await colyseus.connectTo(room, { ...join, name });
        return { room, host };
    };

    it('uses a short, unambiguous code as the room id, and the creator owns it', async () => {
        const { room, host } = await createParty('Ada');
        assert.equal(room.roomId.length, ROOM.CODE_LENGTH);
        assert.match(room.roomId, new RegExp(`^[${ROOM.CODE_ALPHABET}]+$`));
        assert.equal(room.state.roomCode, room.roomId);

        await host.waitForNextPatch();
        const me = host.state.players.get(host.sessionId);
        assert.equal(me?.name, 'Ada');
        assert.equal(me?.isOwner, true);
        assert.equal(me?.ready, true, 'the owner is always ready');
    });

    it('lets others join with the code, and refuses an outdated client', async () => {
        const { room } = await createParty();
        const guest = await colyseus.sdk.joinById(room.roomId, { ...join, name: 'Bo' });
        assert.equal(room.state.players.size, 2);
        assert.equal(room.state.players.get(guest.sessionId)?.isOwner, false);

        await assert.rejects(
            colyseus.sdk.joinById(room.roomId, { protocolVersion: PROTOCOL_VERSION - 1 }),
            (error: { code?: number }) => error.code === PROTOCOL_MISMATCH_CODE
        );
    });

    it('answers pings with the room timeline', async () => {
        const { room, host } = await createParty();
        const before = room.scheduler.now();
        const reply = await host.request(ClientRequest.Ping);
        assert.ok(reply.serverTimeMs >= before);
        assert.ok(reply.serverTimeMs <= room.scheduler.now());
    });

    it('publishes the start rules, and only the owner may start once everyone is ready', async () => {
        const { room, host } = await createParty();
        await host.waitForNextPatch();
        assert.equal(host.state.lobby.blockedReason, 'not_enough_players');

        const guest = await colyseus.sdk.joinById(room.roomId, { ...join, name: 'Bo' });
        await guest.waitForNextPatch();
        assert.equal(guest.state.lobby.blockedReason, 'players_not_ready');
        assert.deepEqual([...guest.state.lobby.waitingFor], [guest.sessionId]);

        await assert.rejects(guest.request(ClientRequest.StartCompetition), refusedWith('not_owner'));

        assert.deepEqual(await guest.request(ClientRequest.SetReady, { ready: true }), { ready: true });
        await guest.waitForNextPatch();
        assert.equal(guest.state.lobby.canStart, true);

        const started = await host.request(ClientRequest.StartCompetition);
        assert.ok(started.playlist.length > 0);
        await host.waitForNextPatch();
        assert.equal(host.state.phase, 'competition');
        assert.equal(host.state.round.phase, 'ready-check');
    });

    it('validates requests before they reach the game logic', async () => {
        const { host } = await createParty();
        // Typed clients can't even express this; a hand-rolled one still gets refused.
        await assert.rejects(host.request(ClientRequest.SetMode, { mode: 'everything' } as never));
        await assert.rejects(
            host.request(ClientRequest.SetMode, { mode: 'custom', gameIds: ['hexa-gone'] }),
            refusedWith('invalid_playlist')
        );
        const custom = (await host.request(ClientRequest.SetMode, {
            mode: 'custom',
            gameIds: ['stop-the-clock', 'log-dodge']
        })) as unknown as SetModeReply;
        assert.deepEqual(custom.playlist, ['stop-the-clock', 'log-dodge']);
    });

    it('moves ownership to the longest-connected player when the owner drops', async () => {
        const { room, host } = await createParty();
        const second = await colyseus.sdk.joinById(room.roomId, { ...join, name: 'Second' });
        await colyseus.sdk.joinById(room.roomId, { ...join, name: 'Third' });

        await host.leave(false); // unconsented: the slot is held for a reconnect
        await second.waitForNextPatch();
        assert.equal(second.state.ownerId, second.sessionId);
        assert.equal(second.state.players.get(host.sessionId)?.connected, false);
    });

    it('a dropped player reconnects into the same slot with the same id', async () => {
        const { room, host } = await createParty();
        const guest = await colyseus.sdk.joinById(room.roomId, { ...join, name: 'Bo' });
        const { sessionId, reconnectionToken } = guest;

        guest.reconnection.enabled = false; // reconnect by hand, below
        await guest.leave(false);
        await host.waitForNextPatch();
        assert.equal(host.state.players.get(sessionId)?.connected, false);

        const back = await colyseus.sdk.reconnect(reconnectionToken);
        assert.equal(back.sessionId, sessionId);
        await host.waitForNextPatch();
        assert.equal(host.state.players.get(sessionId)?.connected, true);
        assert.equal(room.state.players.size, 2);
    });
});
