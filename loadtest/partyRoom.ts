/**
 * Load test: N simulated players join one party room, keep their clock in
 * sync and press ready. Create a room first, then pass its code:
 *
 *   npm run loadtest -- --roomId ABCD --numClients 11
 */

import { cli, type Options } from '@colyseus/loadtest';
import { Client } from '@colyseus/sdk';
import { ClockSync, nextPingDelayMs } from '../src/shared/clockSync.js';
import { PROTOCOL_VERSION } from '../src/shared/constants.js';
import { ClientRequest, type PingReply } from '../src/shared/protocol.js';

cli(async (options: Options) => {
    const client = new Client(options.endpoint);
    const room = await client.joinById(options.roomId, {
        protocolVersion: PROTOCOL_VERSION,
        name: `Bot ${options.clientId}`
    });
    console.log(`joined ${room.roomId} as ${room.sessionId}`);

    const clock = new ClockSync();
    let pingsSent = 0;
    const pingLoop = async (): Promise<void> => {
        const sentAt = performance.now();
        const reply: PingReply = await room.request(ClientRequest.Ping);
        clock.addSample(sentAt, performance.now(), reply.serverTimeMs);
        setTimeout(pingLoop, nextPingDelayMs(++pingsSent));
    };
    void pingLoop();

    await room.request(ClientRequest.SetReady, { ready: true });
    room.onLeave((code) => console.log(`${room.sessionId} left (${code})`));
});
