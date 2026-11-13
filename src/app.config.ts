/**
 * Server configuration: the rooms, HTTP routes and dev tools.
 *
 * Keep this file in the shape Colyseus Cloud expects; see src/index.ts.
 */

import { defineRoom, defineServer, monitor, playground } from 'colyseus';
import { PARTY_ROOM_NAME } from './shared/protocol.js';
import { PartyRoom } from './server/rooms/party/PartyRoom.js';

const server = defineServer({
    rooms: {
        [PARTY_ROOM_NAME]: defineRoom(PartyRoom)
    },

    express: (app) => {
        app.get('/health', (_req, res) => {
            res.json({ ok: true });
        });

        // Dev tools only. Protect /monitor with a password before exposing it.
        if (process.env.NODE_ENV !== 'production') {
            app.use('/monitor', monitor());
            app.use('/', playground());
        }
    }
});

export default server;
