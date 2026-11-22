/**
 * Bots that fill a Skribbl room and play: they pick words and scribble when
 * it's their turn, and guess when it isn't, from words that fit the pattern
 * on screen (so as the hints come in, some of them get it). For trying a full
 * room by hand: host a Skribbl game in a browser, then
 *
 *   npm run bots:skribbl -- --room ABCD --count 5
 *
 * Options: --endpoint (default http://localhost:2567).
 */

import { Client, type Room } from '@colyseus/sdk';
import { PROTOCOL_VERSION } from '../src/shared/constants.js';
import { encodeDrawPacket, type CanvasOp } from '../src/shared/standalone/skribbl/canvas.js';
import { CANVAS, SKRIBBL_CHAT } from '../src/shared/standalone/skribbl/constants.js';
import { wordPattern } from '../src/shared/standalone/skribbl/hints.js';
import {
    SkribblBytes,
    SkribblMessage,
    SkribblRequest,
    type WordChoicesPayload
} from '../src/shared/standalone/skribbl/protocol.js';
import { playableWords } from '../src/server/standalone/skribbl/wordBank.js';

const arg = (name: string, fallback: string): string => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
};
const ROOM_CODE = arg('room', '').toUpperCase();
const COUNT = Number(arg('count', '5'));
const ENDPOINT = arg('endpoint', 'http://localhost:2567');
if (ROOM_CODE === '') throw new Error('Pass --room CODE');

const NAMES = ['Avery', 'Blake', 'Casey', 'Devon', 'Emerson', 'Finley', 'Grey', 'Harper', 'Indigo', 'Jules', 'Kai'];
const AVATARS = ['fox', 'owl', 'cat', 'bear', 'frog', 'panda', 'tiger', 'koala', 'lion', 'otter', 'seal'];
const WORDS = playableWords();

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const randInt = (n: number) => Math.floor(Math.random() * n);
const clamp = (value: number, max: number) => Math.max(0, Math.min(max - 1, Math.round(value)));

/** Does `word` fit what a guesser can see, e.g. "p____ ____"? */
const fits = (word: string, pattern: string): boolean =>
    word.length === pattern.length &&
    [...pattern].every((char, i) => (char === '_' ? wordPattern(word[i]!) === '_' : char === word[i]));

interface TurnView {
    phase: string;
    turnId: number;
    drawerId: string;
    wordPattern: string;
    guessed: { includes(id: string): boolean };
}

class Bot {
    private room!: Room;
    private pen = { x: 400, y: 300, heading: 0, strokeOpen: false, color: 1, size: 2 };
    private nextGuessAt = 0;
    private tried = new Set<string>();
    private lastTurnId = -1;

    constructor(readonly index: number) {}

    private get name(): string {
        return NAMES[this.index % NAMES.length]!;
    }

    async join(client: Client): Promise<void> {
        this.room = await client.joinById(ROOM_CODE, {
            protocolVersion: PROTOCOL_VERSION,
            name: this.name,
            avatar: AVATARS[this.index % AVATARS.length]
        });
        this.room.onMessage(SkribblMessage.WordChoices, (payload: WordChoicesPayload) => {
            setTimeout(() => {
                this.request(SkribblRequest.ChooseWord, { turnId: payload.turnId, index: randInt(payload.words.length) });
            }, rand(1_000, 4_000));
        });
        for (const type of [SkribblMessage.Word, SkribblMessage.Chat, SkribblMessage.TurnEnded, SkribblMessage.GameEnded]) {
            this.room.onMessage(type, () => undefined);
        }
        for (const type of [SkribblBytes.Draw, SkribblBytes.Canvas]) this.room.onMessage(type, () => undefined);
        this.room.onLeave((code) => console.log(`${this.name} left (${code})`));
        setInterval(() => this.tick(), 50);
    }

    private request(type: string, payload?: unknown): void {
        this.room.request(type, payload).catch(() => undefined);
    }

    private tick(): void {
        const turn = (this.room.state as { turn?: TurnView }).turn;
        if (!turn || turn.phase !== 'drawing') return;
        if (turn.turnId !== this.lastTurnId) {
            this.lastTurnId = turn.turnId;
            this.tried.clear();
            this.pen.strokeOpen = false;
            this.nextGuessAt = Date.now() + rand(2_000, 6_000);
        }
        if (turn.drawerId === this.room.sessionId) this.scribble(turn.turnId);
        else if (!turn.guessed.includes(this.room.sessionId)) this.guess(turn.wordPattern);
    }

    /** One draw packet: a wandering line, now and then a new stroke or a fill. */
    private scribble(turnId: number): void {
        const ops: CanvasOp[] = [];
        const pen = this.pen;
        if (!pen.strokeOpen || Math.random() < 0.03) {
            if (Math.random() < 0.05) {
                ops.push({ op: 'fill', color: randInt(CANVAS.PALETTE_SIZE), x: randInt(CANVAS.WIDTH), y: randInt(CANVAS.HEIGHT) });
            }
            pen.x = randInt(CANVAS.WIDTH);
            pen.y = randInt(CANVAS.HEIGHT);
            pen.color = randInt(CANVAS.PALETTE_SIZE);
            pen.size = randInt(CANVAS.BRUSH_SIZES);
            ops.push({ op: 'begin', color: pen.color, size: pen.size, x: pen.x, y: pen.y });
            pen.strokeOpen = true;
        }
        const points = [];
        for (let i = 0; i < 3; i++) {
            pen.heading += rand(-0.5, 0.5);
            pen.x = clamp(pen.x + Math.cos(pen.heading) * 8, CANVAS.WIDTH);
            pen.y = clamp(pen.y + Math.sin(pen.heading) * 8, CANVAS.HEIGHT);
            points.push({ x: pen.x, y: pen.y, dtMs: 16 });
        }
        ops.push({ op: 'points', points });
        this.room.sendBytes(SkribblBytes.Draw, encodeDrawPacket({ turnId, ops }));
    }

    private guess(pattern: string): void {
        if (Date.now() < this.nextGuessAt || pattern === '') return;
        this.nextGuessAt = Date.now() + Math.max(SKRIBBL_CHAT.MIN_INTERVAL_MS, rand(3_000, 8_000));
        const candidates = WORDS.filter((word) => !this.tried.has(word) && fits(word, pattern));
        const word = candidates[randInt(candidates.length)] ?? WORDS[randInt(WORDS.length)]!;
        this.tried.add(word);
        this.request(SkribblRequest.Say, { text: word });
    }
}

const client = new Client(ENDPOINT);
for (let i = 0; i < COUNT; i++) {
    const bot = new Bot(i);
    await bot.join(client);
    console.log(`bot ${i + 1}/${COUNT} joined ${ROOM_CODE}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
}
