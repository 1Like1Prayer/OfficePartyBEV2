/**
 * Opening a standalone game from the party lobby, against a real server:
 * the owner launches Skribbl, the party publishes the game room's code,
 * the owner's token makes them the game's owner even when someone else gets
 * there first, and the link clears once everyone has left the game room.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ColyseusTestServer } from '@colyseus/testing';
import appConfig from '../../src/app.config.js';
import { PROTOCOL_VERSION } from '../../src/shared/constants.js';
import { ClientRequest, PARTY_ROOM_NAME, type LaunchStandaloneReply } from '../../src/shared/protocol.js';
import type { PartyRoom } from '../../src/server/rooms/party/PartyRoom.js';

const join = { protocolVersion: PROTOCOL_VERSION };
const refusedWith = (code: string) => (error: { reason?: { code?: string } }) => error.reason?.code === code;

const until = async (check: () => boolean, what: string): Promise<void> => {
    for (let waited = 0; !check(); waited += 10) {
        if (waited > 3_000) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

describe('launching a standalone game from the party lobby', () => {
    let colyseus: ColyseusTestServer<typeof appConfig>;

    before(async () => {
        await appConfig.listen(2570);
        colyseus = new ColyseusTestServer(appConfig);
    });
    after(async () => colyseus.shutdown());
    beforeEach(async () => colyseus.cleanup());

    it('opens a Skribbl room owned by the party owner, and forgets it once everyone leaves', async () => {
        const party = await colyseus.createRoom<PartyRoom>(PARTY_ROOM_NAME, {});
        const owner = await colyseus.connectTo(party, { ...join, name: 'Ada' });
        const guest = await colyseus.sdk.joinById(party.roomId, { ...join, name: 'Bo' });
        await owner.waitForNextPatch();

        await assert.rejects(
            guest.request(ClientRequest.LaunchStandalone, { gameId: 'skribbl' }),
            refusedWith('not_owner')
        );

        const reply = (await owner.request(ClientRequest.LaunchStandalone, { gameId: 'skribbl' })) as unknown as LaunchStandaloneReply;
        assert.equal(reply.roomCode.length, 4);
        await until(() => guest.state.standalone?.roomCode === reply.roomCode, 'the code to reach the guest');
        assert.equal(guest.state.standalone.gameId, 'skribbl');

        // Only one at a time.
        await assert.rejects(
            owner.request(ClientRequest.LaunchStandalone, { gameId: 'skribbl' }),
            refusedWith('wrong_phase')
        );

        // The guest gets there first, but the owner's token takes the room.
        const guestInGame = await colyseus.sdk.joinById(reply.roomCode, { ...join, name: 'Bo' });
        const ownerInGame = await colyseus.sdk.joinById(reply.roomCode, { ...join, name: 'Ada', ownerToken: reply.ownerToken });
        await until(() => ownerInGame.state.ownerId === ownerInGame.sessionId, 'the owner to own the game room');
        await until(() => guestInGame.state.players.get(guestInGame.sessionId)?.isOwner === false, 'the guest to hand it over');

        // Both keep their party seats meanwhile.
        assert.equal(party.state.players.size, 2);

        await guestInGame.leave();
        await ownerInGame.leave();
        await until(() => owner.state.standalone.roomCode === '', 'the party to forget the closed game');
    });
});
