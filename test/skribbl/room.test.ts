/**
 * The Skribbl room against a real Colyseus server: joining by code, the
 * protocol check, a turn played end to end (private word, binary drawing,
 * guessing), and catching up after joining mid-turn.
 *
 * Timing is covered on a fake clock in game.test.ts.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ClientRoom } from '@colyseus/sdk';
import appConfig from '../../src/app.config.js';
import { PROTOCOL_VERSION, ROOM } from '../../src/shared/constants.js';
import { ClientRequest, PROTOCOL_MISMATCH_CODE } from '../../src/shared/protocol.js';
import { STANDALONE_CATALOG } from '../../src/shared/standalone/catalog.js';
import { decodeDrawPacket, encodeDrawPacket, type CanvasOp } from '../../src/shared/standalone/skribbl/canvas.js';
import {
    SKRIBBL_ROOM_NAME,
    SkribblBytes,
    SkribblMessage,
    SkribblRequest,
    type ChatPayload,
    type ChooseWordReply,
    type SayReply,
    type WordChoicesPayload,
    type WordPayload
} from '../../src/shared/standalone/skribbl/protocol.js';
import type { SkribblRoom } from '../../src/server/rooms/skribbl/SkribblRoom.js';

const join = { protocolVersion: PROTOCOL_VERSION };
const refusedWith = (code: string) => (error: { reason?: { code?: string } }) => error.reason?.code === code;

/** Resolve with the next message of `type` this client receives; fail after 3 s rather than hang. */
const nextMessage = <T>(room: ClientRoom, type: string): Promise<T> =>
    new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`no "${type}" message arrived`)), 3_000);
        const off = room.onMessage(type, (payload: T) => {
            clearTimeout(timeout);
            off();
            resolve(payload);
        });
    });

/**
 * Wait until `check` holds. Better than waitForNextPatch when the patch may
 * already have arrived (a private message is sent right after it).
 */
const until = async (check: () => boolean, what: string): Promise<void> => {
    for (let waited = 0; !check(); waited += 10) {
        if (waited > 3_000) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

const stroke: CanvasOp[] = [
    { op: 'begin', color: 2, size: 1, x: 100, y: 100 },
    { op: 'points', points: [{ x: 120, y: 110, dtMs: 16 }, { x: 140, y: 125, dtMs: 17 }] }
];

describe('skribbl room', () => {
    let colyseus: ColyseusTestServer<typeof appConfig>;

    before(async () => {
        // Test files run in parallel and partyRoom.test.ts boots on the default
        // port (2568). boot() ignores its port for a Server, so listen directly.
        await appConfig.listen(2569);
        colyseus = new ColyseusTestServer(appConfig);
    });
    after(async () => colyseus.shutdown());
    beforeEach(async () => colyseus.cleanup());

    const createGame = async () => {
        const room = await colyseus.createRoom<SkribblRoom>(SKRIBBL_ROOM_NAME, {});
        const host = await colyseus.connectTo(room, { ...join, name: 'Ada' });
        const guest = await colyseus.sdk.joinById(room.roomId, { ...join, name: 'Bo' });
        return { room, host, guest };
    };

    it('is the room the standalone catalogue points to, joined by a short code', async () => {
        assert.equal(STANDALONE_CATALOG.skribbl.roomName, SKRIBBL_ROOM_NAME);
        const { room, host } = await createGame();
        assert.equal(room.roomId.length, ROOM.CODE_LENGTH);
        await host.waitForNextPatch();
        assert.equal(host.state.roomCode, room.roomId);
        assert.equal(host.state.players.get(host.sessionId)?.isOwner, true);
        assert.equal(host.state.canStart, true);

        await assert.rejects(
            colyseus.sdk.joinById(room.roomId, { protocolVersion: PROTOCOL_VERSION - 1 }),
            (error: { code?: number }) => error.code === PROTOCOL_MISMATCH_CODE
        );
        const reply = await host.request(ClientRequest.Ping);
        assert.ok(reply.serverTimeMs >= 0);
    });

    it('plays a turn: the word stays private, the drawing reaches the guesser, and a right guess scores', async () => {
        const { host, guest } = await createGame();
        await assert.rejects(guest.request(SkribblRequest.Start), refusedWith('not_owner'));
        await host.request(SkribblRequest.UpdateSettings, { drawTimeSec: 60 });

        const choicesArrive = nextMessage<WordChoicesPayload>(host, SkribblMessage.WordChoices);
        await host.request(SkribblRequest.Start);
        const choices = await choicesArrive;
        assert.equal(choices.words.length, 3);

        const wordArrives = nextMessage<WordPayload>(host, SkribblMessage.Word);
        // Validated handlers type their reply as void on the client (see README), so name it here.
        const chosen = (await host.request(SkribblRequest.ChooseWord, { turnId: choices.turnId, index: 1 })) as unknown as ChooseWordReply;
        const word = chosen.word;
        assert.equal(word, choices.words[1]);
        assert.equal((await wordArrives).word, word);

        await until(() => guest.state.turn.phase === 'drawing', 'the drawing phase');
        assert.equal(guest.state.turn.drawTimeMs, 60_000);
        assert.ok(!JSON.stringify(guest.state.toJSON()).includes(word), 'the word is not in synced state');

        const drawingArrives = nextMessage<Uint8Array>(guest, SkribblBytes.Draw);
        host.sendBytes(SkribblBytes.Draw, encodeDrawPacket({ turnId: choices.turnId, ops: stroke }));
        assert.deepEqual(decodeDrawPacket(await drawingArrives)?.ops, stroke);

        const wrong = (await guest.request(SkribblRequest.Say, { text: 'definitely not it' })) as unknown as SayReply;
        assert.equal(wrong.verdict, 'sent');
        await new Promise((resolve) => setTimeout(resolve, 300)); // the chat rate limit

        const noticeArrives = nextMessage<ChatPayload>(host, SkribblMessage.Chat);
        const guessed = (await guest.request(SkribblRequest.Say, { text: word.toUpperCase() })) as unknown as SayReply;
        assert.equal(guessed.verdict, 'correct');
        const notice = await noticeArrives;
        assert.equal(notice.kind, 'guessed');

        // The only guesser got it, so the turn is over.
        await until(() => host.state.turn.phase === 'reveal', 'the reveal');
        assert.ok((host.state.players.get(guest.sessionId)?.points ?? 0) > 0);
    });

    it('sends a player who joins mid-turn the drawing so far', async () => {
        const { room, host } = await createGame();
        const choicesArrive = nextMessage<WordChoicesPayload>(host, SkribblMessage.WordChoices);
        await host.request(SkribblRequest.Start);
        const { turnId } = await choicesArrive;
        await host.request(SkribblRequest.ChooseWord, { turnId, index: 0 });
        host.sendBytes(SkribblBytes.Draw, encodeDrawPacket({ turnId, ops: stroke }));
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Listen before the join completes: the snapshot follows the first state patch.
        const late = await colyseus.sdk.joinById(room.roomId, { ...join, name: 'Cy' });
        const snapshot = await nextMessage<Uint8Array>(late, SkribblBytes.Canvas);
        const ops = decodeDrawPacket(snapshot)?.ops;
        assert.equal(ops?.[0]?.op, 'clear');
        assert.equal(ops?.length, 3);
        assert.equal(late.state.players.get(late.sessionId)?.isSpectator, false, 'plays straight away');
    });
});
