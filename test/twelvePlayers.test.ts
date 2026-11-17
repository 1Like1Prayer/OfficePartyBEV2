/**
 * A full room: twelve players through every game, start to leaderboard, on
 * the fake clock. Bots play each round in one of a few ways: everyone level
 * (so every tiebreaker and the coin flip run with a big field), a spread of
 * results, and a messy room where people drop out, come back, never report or
 * send rubbish. Whatever happens, the competition must finish, award exactly
 * one point a scoring round, and leave nobody out of the standings.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ROOM } from '../src/shared/constants.js';
import { implementedGameIds, type GameId } from '../src/shared/games/catalog.js';
import type { CubeCounterRound } from '../src/shared/games/cubeCounter/types.js';
import { HEX_DROP } from '../src/shared/games/hexDrop/constants.js';
import { MAGE_BATTLE } from '../src/shared/games/mageBattle/constants.js';
import type { HexDropRound } from '../src/shared/games/hexDrop/types.js';
import type { StopTheClockRound } from '../src/shared/games/stopTheClock.js';
import {
    ServerMessage,
    type LeaderboardPayload,
    type RoundClosingPayload,
    type RoundDataPayload,
    type RoundResultsPayload
} from '../src/shared/protocol.js';
import { createPartyHarness } from './support/partyHarness.js';

type Scenario = 'level' | 'spread' | 'messy';

const PLAYERS = Array.from({ length: ROOM.MAX_PLAYERS }, (_, index) => `p${String(index + 1).padStart(2, '0')}`);
const TICK_MS = 100;
/** Far longer than any competition of every game could take, tiebreakers and all. */
const MAX_SIMULATED_MS = 6 * 60 * 60 * 1000;

interface Plan {
    /** Race time to send the result at, unless told to stop sooner. */
    atMs: number;
    result: () => unknown;
}

/** What one bot does this attempt. */
const planFor = (gameId: GameId, data: unknown, index: number, scenario: Scenario): Plan | null => {
    const level = scenario === 'level';
    if (scenario === 'messy' && index % 4 === 3) return null; // never reports
    if (scenario === 'messy' && index === 1) return { atMs: 500, result: () => ({ nonsense: true }) };
    switch (gameId) {
        case 'stop-the-clock': {
            const { targetMs } = data as StopTheClockRound;
            const elapsedMs = level ? targetMs : targetMs + (index - 5) * 37;
            return { atMs: elapsedMs, result: () => ({ elapsedMs, timingSuspect: false }) };
        }
        case 'cube-counter': {
            const { puzzles } = data as CubeCounterRound;
            const answers = puzzles.map((puzzle, n) => ({
                count: level ? puzzle.boxes.length : puzzle.boxes.length + ((index + n) % 3) - 1,
                answerMs: level ? 1_000 : 400 + index * 90,
            }));
            return { atMs: 5_000, result: () => ({ answers, timingSuspect: false }) };
        }
        case 'hex-drop': {
            // Level: nobody ever falls. Spread: one falls every second, the last is told to stop.
            const outAtMs = level || index === PLAYERS.length - 1 ? null : 1_000 * (index + 1);
            // Someone still up stops when the round's clock runs out, as the client does.
            return { atMs: outAtMs ?? HEX_DROP.MAX_ROUND_MS, result: () => ({ outAtMs, timingSuspect: false }) };
        }
        case 'mage-battle':
            return { atMs: MAGE_BATTLE.ROUND_MS, result: () => ({ timingSuspect: false }) };
        case 'type-racer-roulette': {
            const endedAtMs = level ? 30_000 : 4_000 + index * 500;
            return { atMs: endedAtMs, result: () => ({ events: [], endedAtMs, timingSuspect: false }) };
        }
        case 'minefield':
        case 'crusher-escalator':
        case 'log-dodge':
            return { atMs: level ? 2_000 : 1_000 + index * 300, result: () => ({ inputs: [], timingSuspect: false }) };
    }
};

const playCompetition = (playlist: GameId[], scenario: Scenario) => {
    const party = createPartyHarness(PLAYERS);
    party.lobby.setMode('p01', 'custom', playlist);
    party.readyUp();
    const started = party.match.start('p01');
    assert.equal(started.ok, true, JSON.stringify(started));

    let attemptKey = '';
    let plans = new Map<string, Plan>();
    const sent = new Set<string>();
    const refusals: string[] = [];
    let closingSeen = 0;
    let dropped: string | null = null;

    while (party.state.phase === 'competition') {
        assert.ok(party.clock.now() < MAX_SIMULATED_MS, `stuck in ${party.state.round.phase} of ${party.state.round.gameId}`);
        const round = party.state.round;
        const key = `${round.roundId}:${round.attempt}`;

        if (round.phase === 'ready-check') {
            for (const id of round.participants) {
                if (id === dropped) continue;
                if (!round.ready.includes(id)) party.match.markReady(id, round.roundId, round.attempt);
            }
        }

        if (round.phase === 'playing') {
            if (key !== attemptKey) {
                attemptKey = key;
                sent.clear();
                const roundData = party.messages<RoundDataPayload>(ServerMessage.RoundData).at(-1)!;
                assert.equal(roundData.roundId, round.roundId);
                plans = new Map();
                round.participants.forEach((id) => {
                    const plan = planFor(round.gameId as GameId, roundData.data, PLAYERS.indexOf(id), scenario);
                    if (plan !== null) plans.set(id, plan);
                });
                // Messy: someone drops at the start of every attempt, and is back a few seconds on.
                if (scenario === 'messy') {
                    dropped = round.participants[round.participants.length - 1] ?? null;
                    if (dropped !== null) {
                        party.members.markDisconnected(dropped);
                        party.match.onPlayerGone(dropped);
                    }
                }
                if (round.gameId === 'hex-drop') {
                    const { spawns } = roundData.data as HexDropRound;
                    for (const id of round.participants) {
                        party.match.handleAction(id, round.roundId, round.attempt, { type: 'touch', tile: spawns[id], atMs: 0 });
                    }
                }
            }

            const raceMs = party.clock.now() - round.timingStartsAtMs!;
            if (dropped !== null && raceMs > 3_000) {
                party.members.markReconnected(dropped);
                party.match.onPlayerReconnected(dropped);
                dropped = null;
            }

            if (round.gameId === 'mage-battle' && scenario !== 'level') {
                // Everyone mashes, each to their own rhythm; the server decides what scored.
                for (const [n, id] of round.participants.entries()) {
                    if (Math.floor(raceMs / TICK_MS) % (3 + n) === 0) {
                        party.match.handleAction(id, round.roundId, round.attempt, { type: 'press', atMs: Math.round(raceMs) });
                    }
                }
            }

            const closing = party.messages<RoundClosingPayload>(ServerMessage.RoundClosing)
                .filter((message) => message.roundId === round.roundId && message.attempt === round.attempt)
                .flatMap((message) => message.pending);
            for (const [id, plan] of plans) {
                if (sent.has(id) || id === dropped) continue;
                if (plan.atMs <= raceMs || closing.includes(id)) {
                    sent.add(id);
                    const reply = party.match.submitResult(id, round.roundId, round.attempt, plan.result());
                    if (!reply.ok) refusals.push(`${round.gameId} ${id}: ${reply.error.code}`);
                }
            }
            closingSeen += closing.length > 0 ? 1 : 0;
        }

        party.clock.advance(TICK_MS);
        if (dropped !== null && party.state.round.roundId !== round.roundId) {
            party.members.markReconnected(dropped);
            party.match.onPlayerReconnected(dropped);
            dropped = null;
        }
    }

    return { party, refusals, closingSeen };
};

const checkStandings = (party: ReturnType<typeof createPartyHarness>) => {
    assert.equal(party.state.phase, 'leaderboard');
    const results = party.messages<RoundResultsPayload>(ServerMessage.RoundResults);
    const finals = results.filter((result) => result.isFinal);
    assert.equal(finals.length, party.state.totalRounds, 'one decided result per scoring round');
    for (const result of results) {
        const named = [...result.ranked.map((entry) => entry.playerId), ...result.noShow];
        assert.equal(new Set(named).size, named.length, 'nobody listed twice');
        if (result.isFinal) assert.ok(result.winnerId !== null || result.ranked.length === 0, 'a final names a winner');
    }
    const board = party.messages<LeaderboardPayload>(ServerMessage.Leaderboard).at(-1)!;
    assert.deepEqual(board.rows.map((row) => row.playerId).sort(), [...PLAYERS].sort(), 'all twelve on the board');
    const points = board.rows.reduce((sum, row) => sum + row.points, 0);
    assert.equal(points, finals.filter((result) => result.winnerId !== null).length, 'one point per decided round');
    return { results, board };
};

describe('a full room of twelve', () => {
    for (const gameId of implementedGameIds()) {
        for (const scenario of ['level', 'spread', 'messy'] as const) {
            it(`${gameId}: ${scenario}`, () => {
                const { party, refusals, closingSeen } = playCompetition([gameId], scenario);
                const { results } = checkStandings(party);
                if (process.env.PEEK) console.log(`PEEK ${gameId} ${scenario}: attempts=${results.length} coin=${results.filter((r) => r.decidedByCoinFlip).length} noShows=${results.map((r) => r.noShow.length).join(",")} winners=${results.map((r) => r.winnerId ?? "-").join(",")} refusals=${refusals.length} closings=${closingSeen} simMin=${Math.round(party.clock.now() / 60000)}`);
                if (scenario !== 'messy') {
                    assert.deepEqual(refusals, [], 'every honest result is taken');
                    for (const result of results) assert.deepEqual(result.noShow, [], 'nobody honest is a no-show');
                }
                if (scenario === 'level') {
                    // Twelve level players: tiebreakers among all of them, and a coin flip if it never breaks.
                    assert.ok(results.some((result) => !result.isFinal) || results.every((result) => result.winnerId !== null));
                }
            });
        }
    }

    it('every game in one run, played messily, still reaches the leaderboard and the lobby', () => {
        const { party } = playCompetition(implementedGameIds(), 'messy');
        checkStandings(party);
    });

});
