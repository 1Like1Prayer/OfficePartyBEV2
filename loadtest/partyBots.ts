/**
 * Bots that fill a room and actually play: they ready up, play every game
 * roughly like people do (some good, some bad), send the live progress other
 * screens draw, and report results. For trying a full room by hand: host in a
 * browser, then
 *
 *   npx tsx loadtest/partyBots.ts --room ABCD --count 11
 *
 * Options: --endpoint (default http://localhost:2567), --flaky (some bots
 * drop their connection mid-round and come back).
 */

import { Client, type Room } from '@colyseus/sdk';
import { ClockSync, nextPingDelayMs } from '../src/shared/clockSync.js';
import { PROTOCOL_VERSION } from '../src/shared/constants.js';
import type { DIRECTIONS } from '../src/shared/games/crusherEscalator/constants.js';
import { arrowSequence } from '../src/shared/games/crusherEscalator/stream.js';
import type { CrusherEscalatorRound } from '../src/shared/games/crusherEscalator/types.js';
import type { CubeCounterRound } from '../src/shared/games/cubeCounter/types.js';
import { CUBE_COUNTER } from '../src/shared/games/cubeCounter/constants.js';
import { TILES } from '../src/shared/games/hexDrop/arena.js';
import { HEX_DROP } from '../src/shared/games/hexDrop/constants.js';
import { startState, stepRunner, type RunnerState } from '../src/shared/games/hexDrop/movement.js';
import type { HexDropRound, Tile } from '../src/shared/games/hexDrop/types.js';
import { ACTIONS, COUNTER_ACTION, LOG_DODGE } from '../src/shared/games/logDodge/constants.js';
import { judgePlayer } from '../src/shared/games/logDodge/judge.js';
import type { Input as LogInput, LogDodgeRound } from '../src/shared/games/logDodge/types.js';
import { MAGE_BATTLE } from '../src/shared/games/mageBattle/constants.js';
import { MINEFIELD } from '../src/shared/games/minefield/constants.js';
import { simulateRun } from '../src/shared/games/minefield/simulate.js';
import type { Input as MineInput, MinefieldRound } from '../src/shared/games/minefield/types.js';
import type { StopTheClockRound } from '../src/shared/games/stopTheClock.js';
import { TYPE_RACER } from '../src/shared/games/typeRacer/constants.js';
import type { TypeRacerRound, TypingEvent } from '../src/shared/games/typeRacer/types.js';
import {
    ClientMessage,
    ClientRequest,
    ServerMessage,
    type PingReply,
    type RoundClosingPayload,
    type RoundDataPayload
} from '../src/shared/protocol.js';

const arg = (name: string, fallback: string): string => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
};
const ROOM_CODE = arg('room', '').toUpperCase();
const COUNT = Number(arg('count', '11'));
const ENDPOINT = arg('endpoint', 'http://localhost:2567');
const FLAKY = process.argv.includes('--flaky');
if (ROOM_CODE === '') throw new Error('Pass --room CODE');

const NAMES = ['Avery', 'Blake', 'Casey', 'Devon', 'Emerson', 'Finley', 'Grey', 'Harper', 'Indigo', 'Jules', 'Kai', 'Logan', 'Morgan', 'Noor'];
const AVATARS = ['fox', 'owl', 'cat', 'bear', 'frog', 'panda', 'tiger', 'koala', 'lion', 'otter', 'seal', 'wolf'];

/** What a bot does in one attempt: called every tick with the race time; returns a result to send, once. */
interface Play {
    tick(raceMs: number): void;
    /** The result to report now, or null to keep playing. `told` once the server says stop. */
    resultAt(raceMs: number, told: boolean): unknown | null;
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

class Bot {
    private room!: Room;
    private readonly clock = new ClockSync();
    private play: Play | null = null;
    private attemptKey = '';
    private reported = false;
    private told = false;
    private lastProgressAt = 0;
    private readonly roundData = new Map<string, RoundDataPayload>();
    /** 0 (hopeless) to 1 (sharp): how well this bot plays. */
    readonly skill: number;

    constructor(readonly index: number) {
        this.skill = 0.35 + 0.6 * ((index * 7) % 11) / 10;
    }

    async join(client: Client): Promise<void> {
        this.room = await client.joinById(ROOM_CODE, {
            protocolVersion: PROTOCOL_VERSION,
            name: NAMES[this.index % NAMES.length],
            avatar: AVATARS[this.index % AVATARS.length]
        });
        this.wire();
        void this.pingLoop(0);
        setInterval(() => { this.tick(); }, 50);
    }

    private wire(): void {
        this.room.onMessage(ServerMessage.RoundData, (payload: RoundDataPayload) => {
            this.roundData.set(`${payload.roundId}:${payload.attempt}`, payload);
        });
        this.room.onMessage(ServerMessage.RoundClosing, (payload: RoundClosingPayload) => {
            if (payload.pending.includes(this.room.sessionId)) this.told = true;
        });
        for (const type of [ServerMessage.RoundResults, ServerMessage.GameStarting, ServerMessage.Leaderboard]) {
            this.room.onMessage(type, () => undefined);
        }
        this.room.onLeave((code) => { console.log(`${this.name} left (${code})`); });
    }

    private get name(): string {
        return NAMES[this.index % NAMES.length]!;
    }

    private async pingLoop(sent: number): Promise<void> {
        try {
            const sentAt = performance.now();
            const reply: PingReply = await this.room.request(ClientRequest.Ping);
            this.clock.addSample(sentAt, performance.now(), reply.serverTimeMs);
        } catch { /* reconnecting */ }
        setTimeout(() => { void this.pingLoop(sent + 1); }, nextPingDelayMs(sent + 1));
    }

    private request(type: string, payload?: unknown): void {
        this.room.request(type, payload).catch((error: unknown) => {
            console.log(`${this.name}: ${type} refused: ${error instanceof Error ? error.message : String(error)}`);
        });
    }

    private tick(): void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = this.room.state as any;
        if (state === undefined || !this.clock.isSynced) return;
        const me = state.players?.get(this.room.sessionId);
        if (state.phase === 'lobby') {
            if (me !== undefined && !me.ready) this.request(ClientRequest.SetReady, { ready: true });
            return;
        }
        const round = state.round;
        if (round === undefined) return;
        const envelope = { roundId: round.roundId, attempt: round.attempt };
        const key = `${round.roundId}:${round.attempt}`;
        const inRound = [...round.participants].includes(this.room.sessionId);
        if (!inRound) return;

        if (round.phase === 'ready-check' && ![...round.ready].includes(this.room.sessionId)) {
            if (this.readyAskedFor !== key) {
                this.readyAskedFor = key;
                // People take a moment to press ready.
                setTimeout(() => { this.request(ClientRequest.ReadyForRound, envelope); }, rand(300, 2_500));
            }
        }

        if (round.phase !== 'playing') return;
        if (key !== this.attemptKey) {
            const data = this.roundData.get(key);
            if (data === undefined) return;
            this.attemptKey = key;
            this.reported = false;
            this.told = false;
            this.play = this.makePlay(data, envelope);
            if (FLAKY && this.index % 5 === 2) this.dropAndReturn();
        }
        if (this.play === null || this.reported) return;

        const raceMs = this.clock.serverNow(performance.now()) - round.timingStartsAtMs;
        if (raceMs < 0) return;
        this.play.tick(raceMs);
        const result = this.play.resultAt(raceMs, this.told);
        if (result !== null) {
            this.reported = true;
            this.request(ClientRequest.SubmitResult, { ...envelope, result });
        }
    }

    private readyAskedFor = '';

    private progress(envelope: { roundId: number; attempt: number }, raceMs: number, progress: Record<string, unknown>, hz = 5): void {
        if (raceMs - this.lastProgressAt < 1000 / hz && raceMs >= this.lastProgressAt) return;
        this.lastProgressAt = raceMs;
        this.room.send(ClientMessage.Progress, { ...envelope, progress });
    }

    private dropAndReturn(): void {
        const token = this.room.reconnectionToken;
        console.log(`${this.name} drops for 4s`);
        // Close the socket without consent, as a lost connection would.
        (this.room.connection as unknown as { close(code?: number): void }).close(4000);
        setTimeout(() => {
            new Client(ENDPOINT).reconnect(token).then((room) => {
                this.room = room;
                this.wire();
                console.log(`${this.name} is back`);
            }).catch((error: unknown) => { console.log(`${this.name} could not reconnect`, error); });
        }, 4_000);
    }

    private makePlay(payload: RoundDataPayload, envelope: { roundId: number; attempt: number }): Play {
        const id = this.room.sessionId;
        const skill = this.skill;
        const send = (raceMs: number, progress: Record<string, unknown>, hz?: number) => { this.progress(envelope, raceMs, progress, hz); };
        this.lastProgressAt = -Infinity;

        switch (payload.gameId) {
            case 'stop-the-clock': {
                const { targetMs } = payload.data as StopTheClockRound;
                const stopAt = Math.round(targetMs + rand(-1, 1) * (1 - skill) * 900);
                return {
                    tick: (t) => { send(t, { running: t < stopAt }); },
                    resultAt: (t, told) => (t >= stopAt || told ? { elapsedMs: Math.min(t, stopAt), timingSuspect: false } : null)
                };
            }
            case 'cube-counter': {
                const { puzzles } = payload.data as CubeCounterRound;
                let at = 0;
                const answers = puzzles.map((puzzle) => {
                    const answerMs = Math.round(rand(1_200, 6_000) * (1.4 - skill));
                    at += puzzle.flashMs + answerMs + CUBE_COUNTER.PAUSE_BETWEEN_PUZZLES_MS;
                    const right = Math.random() < skill;
                    return { count: right ? puzzle.boxes.length : puzzle.boxes.length + (Math.random() < 0.5 ? -1 : 1), answerMs, doneAt: at };
                });
                return {
                    tick: (t) => { send(t, { puzzlesDone: answers.filter((answer) => answer.doneAt <= t).length }); },
                    resultAt: (t, told) =>
                        t >= at || told
                            ? { answers: answers.map(({ count, answerMs }) => ({ count, answerMs })), timingSuspect: false }
                            : null
                };
            }
            case 'crusher-escalator': {
                const { seeds } = payload.data as CrusherEscalatorRound;
                const arrows = arrowSequence(seeds[id]!);
                const inputs: { direction: (typeof DIRECTIONS)[number]; atMs: number }[] = [];
                const gapMs = 180 + (1 - skill) * 260;
                // Tired bots slow down, and are crushed.
                const tiresAt = rand(15_000, 30_000) + skill * 40_000;
                let next = 400;
                return {
                    tick: (t) => {
                        while (next <= t) {
                            inputs.push({ direction: arrows(inputs.length), atMs: Math.round(next) });
                            next += gapMs * rand(0.7, 1.3) * (next > tiresAt ? 3 : 1);
                        }
                        send(t, { score: inputs.length });
                    },
                    resultAt: (t, told) => (told || t > tiresAt + 25_000 || t >= 90_000 ? { inputs, timingSuspect: false } : null)
                };
            }
            case 'log-dodge': {
                const round = payload.data as LogDodgeRound;
                const inputs: LogInput[] = [];
                for (const log of round.logs) {
                    if (Math.random() > 0.55 + skill * 0.42) continue;
                    const atMs = Math.round(log.arriveAtMs - 120 + rand(-1, 1) * (1 - skill) * 200);
                    if (atMs > 0 && (inputs.at(-1)?.atMs ?? -1) < atMs) inputs.push({ action: COUNTER_ACTION[log.height], atMs });
                }
                const out = judgePlayer(round.logs, inputs).eliminatedAtMs;
                return {
                    tick: (t) => {
                        const seen = inputs.filter((input) => input.atMs <= t);
                        const last = seen.at(-1);
                        const hits = judgePlayer(round.logs, seen, t).hits;
                        send(t, last === undefined ? { hits } : { hits, pressAction: ACTIONS.indexOf(last.action), pressAtMs: last.atMs });
                    },
                    resultAt: (t, told) => {
                        const end = out ?? round.durationMs ?? LOG_DODGE.DURATION_MS;
                        return told || t >= end ? { inputs: inputs.filter((input) => input.atMs <= Math.min(t, end)), timingSuspect: false } : null;
                    }
                };
            }
            case 'minefield': {
                const { map } = payload.data as MinefieldRound;
                const inputs: MineInput[] = [{ kind: 'move', atMs: 0, dx: 1, dy: 0 }];
                for (let at = 600; at < MINEFIELD.MAX_RACE_MS; at += rand(400, 1_400) / skill) {
                    const roll = Math.random();
                    if (roll < 0.15 * skill) inputs.push({ kind: 'sonar', atMs: Math.round(at) });
                    else inputs.push({ kind: 'move', atMs: Math.round(at), dx: roll < 0.85 ? 1 : 0, dy: roll < 0.5 ? 0 : roll < 0.7 ? 1 : -1 });
                }
                const whole = simulateRun(map, inputs, MINEFIELD.MAX_RACE_MS, id);
                const end = whole.finishedAtMs ?? whole.eliminatedAtMs ?? MINEFIELD.MAX_RACE_MS;
                return {
                    tick: (t) => {
                        const now = simulateRun(map, inputs.filter((input) => input.atMs <= t), Math.min(t, end), id);
                        const status = now.finishedAtMs !== null ? 1 : now.eliminatedAtMs !== null ? 2 : 0;
                        const last = now.detonations.at(-1);
                        const scan = now.scans.at(-1);
                        send(t, {
                            x: Math.round(now.x * 10), y: Math.round(now.y * 10), t: Math.round(t), lives: now.livesLeft, status,
                            ...(last !== undefined && { mine: last.mineIndex + 1, mineT: Math.round(last.atMs) }),
                            ...(scan !== undefined && { scans: now.scans.length, scanX: Math.round(scan.x * 10), scanY: Math.round(scan.y * 10), scanT: Math.round(scan.atMs) })
                        }, 10);
                    },
                    resultAt: (t, told) => (told || t >= end ? { inputs: inputs.filter((input) => input.atMs <= Math.min(t, end)), timingSuspect: false } : null)
                };
            }
            case 'type-racer-roulette': {
                const { paragraphs } = payload.data as TypeRacerRound;
                const msPerChar = 120 + (1 - skill) * 280;
                const events: TypingEvent[] = [];
                const charsAt: { atMs: number; chars: number; paragraph: number }[] = [];
                let at = 0;
                let chars = 0;
                paragraphs.forEach((lines, p) => {
                    if (p > 0) at += TYPE_RACER.PARAGRAPH_PAUSE_MS;
                    for (const line of lines) {
                        // Key by key for the progress others see; the server only needs the line's end.
                        const perChar = msPerChar * rand(0.8, 1.2);
                        for (let key = 0; key < line.length; key++) {
                            at += perChar;
                            chars += 1;
                            charsAt.push({ atMs: at, chars, paragraph: p });
                        }
                        events.push({ kind: 'line', atMs: Math.round(at) });
                    }
                });
                return {
                    tick: (t) => {
                        const done = charsAt.filter((entry) => entry.atMs <= t).at(-1);
                        send(t, { chars: done?.chars ?? 0, paragraph: done?.paragraph ?? 0, strikes: 0, skulls: 0, status: t >= at ? 1 : 0 });
                    },
                    resultAt: (t, told) =>
                        told || t >= at ? { events: events.filter((event) => event.atMs <= t), endedAtMs: Math.round(Math.min(t, at)), timingSuspect: false } : null
                };
            }
            case 'mage-battle': {
                let nextPress = rand(400, 1_200);
                return {
                    tick: (t) => {
                        if (t < nextPress) return;
                        nextPress = t + rand(500, 1_600) * (1.3 - skill * 0.5);
                        this.room.request(ClientRequest.RoundAction, { ...envelope, action: { type: 'press', atMs: Math.round(t) } }).catch(() => undefined);
                    },
                    resultAt: (t, told) => (told || t >= MAGE_BATTLE.ROUND_MS ? { timingSuspect: false } : null)
                };
            }
            case 'hex-drop': {
                const { spawns } = payload.data as HexDropRound;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const shared = () => (this.room.state as any).round.shared as Map<string, number>;
                let state: RunnerState = startState(TILES[spawns[id]!]!);
                let steps = 0;
                let heading = rand(0, Math.PI * 2);
                let outAt: number | null = null;
                const touched = new Set<number>();
                const stepMs = HEX_DROP.STEP_SECONDS * 1000;
                return {
                    tick: (t) => {
                        while (steps < Math.floor(t / stepMs) && outAt === null) {
                            const endsAt = (steps + 1) * stepMs;
                            if (Math.random() < 0.02) heading += rand(-1.5, 1.5);
                            // Head back towards the middle when near the edge.
                            if (Math.hypot(state.x, state.z) > 9 + state.layer * 3) heading = Math.atan2(-state.z, -state.x);
                            const standing = (tile: Tile) => {
                                const falls = shared().get(String(tile.id));
                                return falls === undefined || falls > endsAt;
                            };
                            state = stepRunner(state, { moveX: Math.cos(heading) * skill, moveZ: Math.sin(heading) * skill, jump: Math.random() < 0.01 + skill * 0.02 }, standing);
                            steps += 1;
                            if (state.tile !== null && !touched.has(state.tile)) {
                                touched.add(state.tile);
                                this.room.request(ClientRequest.RoundAction, { ...envelope, action: { type: 'touch', tile: state.tile, atMs: Math.round(endsAt) } }).catch(() => undefined);
                            }
                            if (state.out) outAt = Math.round(endsAt);
                        }
                        const c = (value: number) => Math.round(value * 100);
                        send(t, { t: Math.round(t), x: c(state.x), y: c(state.y), z: c(state.z), out: state.out ? 1 : 0 }, 20);
                    },
                    resultAt: (t, told) => (outAt !== null || told || t >= HEX_DROP.MAX_ROUND_MS ? { outAtMs: outAt, timingSuspect: false } : null)
                };
            }
            default:
                return { tick: () => undefined, resultAt: (t) => (t > 5_000 ? {} : null) };
        }
    }
}

const client = new Client(ENDPOINT);
for (let index = 0; index < COUNT; index++) {
    const bot = new Bot(index);
    await bot.join(client).catch((error: unknown) => { console.log(`bot ${index} could not join:`, error instanceof Error ? error.message : error); });
    await new Promise((resolve) => setTimeout(resolve, 150));
}
console.log(`${COUNT} bots in ${ROOM_CODE}`);
