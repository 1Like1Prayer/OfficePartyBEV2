import test from 'node:test';
import assert from 'node:assert/strict';
import { seededRandom } from '../random.js';
import { CRUSHER_ESCALATOR, DIRECTIONS } from './constants.js';
import { eliminationGapAt, gapNarrowingTimes } from './gap.js';
import { crusherEscalatorModule } from './module.js';
import { parseCrusherEscalatorProgress, parseCrusherEscalatorResult } from './parsing.js';
import { simulateRace, type Racer } from './race.js';
import { arrowSequence, generatePlayerSeeds } from './stream.js';
import type { ArrowSequence, CrusherEscalatorRound, Direction, Input } from './types.js';

const GAP = CRUSHER_ESCALATOR.ELIMINATION_GAP_START;
const MIN_INTERVAL = CRUSHER_ESCALATOR.MIN_PRESS_INTERVAL_MS;

/* ---------------- arrow sequences ---------------- */

const firstArrows = (arrows: ArrowSequence, count: number): Direction[] =>
    Array.from({ length: count }, (_, i) => arrows(i));

test('a sequence never shows the same direction twice in a row', () => {
    for (let seed = 1; seed <= 200; seed++) {
        const arrows = firstArrows(arrowSequence(seed), 500);
        assert.ok(arrows.every((d, i) => i === 0 || d !== arrows[i - 1]), `seed ${seed}`);
        assert.ok(arrows.every((d) => (DIRECTIONS as readonly string[]).includes(d)));
    }
});

test('a sequence uses all four directions', () => {
    assert.equal(new Set(firstArrows(arrowSequence(5), 40)).size, 4);
});

test('the same seed always gives the same sequence, in any lookup order', () => {
    const inOrder = firstArrows(arrowSequence(1234), 300);
    const lookedUpLateFirst = arrowSequence(1234);
    assert.equal(lookedUpLateFirst(299), inOrder[299]);
    assert.deepEqual(firstArrows(lookedUpLateFirst, 300), inOrder);
});

test('a sequence is endless and does not loop', () => {
    const arrows = firstArrows(arrowSequence(9), 2_000);
    // Any short loop would make some block repeat the one before it.
    for (const period of [30, 50, 100]) {
        const repeats = arrows.slice(period).every((d, i) => d === arrows[i]);
        assert.equal(repeats, false, `period ${period}`);
    }
});

test('every player gets a different seed, and different seeds differ', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
    for (let seed = 1; seed <= 50; seed++) {
        const seeds = generatePlayerSeeds(ids, seededRandom(seed));
        assert.deepEqual(Object.keys(seeds), ids);
        assert.equal(new Set(Object.values(seeds)).size, ids.length);
        assert.ok(Object.values(seeds).every((s) => Number.isInteger(s) && s >= 0 && s <= 0xffff_ffff));
    }
    assert.notDeepEqual(firstArrows(arrowSequence(1), 30), firstArrows(arrowSequence(2), 30));
});

/* ---------------- the narrowing gap ---------------- */

test('the gap holds at 8 for 20 s, then narrows by one every 10 s down to 3', () => {
    const at = (seconds: number) => eliminationGapAt(seconds * 1_000);
    assert.equal(at(0), 8);
    assert.equal(at(19.999), 8);
    assert.equal(at(20), 7);
    assert.equal(at(29.999), 7);
    assert.equal(at(30), 6);
    assert.equal(at(50), 4);
    assert.equal(at(60), 3);
    assert.equal(at(90), 3);
    assert.deepEqual(gapNarrowingTimes(), [20_000, 30_000, 40_000, 50_000, 60_000]);
});

/* ---------------- race ---------------- */

const STREAM: Direction[] = ['up', 'down', 'left', 'right'];
const ARROWS: ArrowSequence = (pressCount) => STREAM[pressCount % STREAM.length]!;

const wrongFor = (direction: Direction): Direction =>
    DIRECTIONS.find((d) => d !== direction)!;

/** `count` presses, one every `stepMs`, each right or wrong as chosen. */
const presses = (
    count: number,
    stepMs: number,
    isRight: (pressIndex: number) => boolean = () => true,
    startMs = 0,
    arrows: ArrowSequence = ARROWS
): Input[] =>
    Array.from({ length: count }, (_, i) => {
        const shown = arrows(i);
        return {
            direction: isRight(i) ? shown : wrongFor(shown),
            atMs: startMs + (i + 1) * stepMs
        };
    });

const racer = (playerId: string, inputs: Input[]): Racer => ({ playerId, inputs, arrows: ARROWS });

const outcomeOf = (outcomes: ReturnType<typeof simulateRace>, playerId: string) =>
    outcomes.find((o) => o.playerId === playerId)!;

test('everyone starts on 0 and a correct press is worth 1, a wrong press 0', () => {
    const [outcome] = simulateRace([
        racer('a', presses(4, 100, (i) => i % 2 === 0)),
        racer('b', [])
    ]);
    // presses 0 and 2 are right; 1 and 3 are wrong.
    assert.equal(outcome!.score, 2);
    assert.equal(simulateRace([racer('x', [])])[0]!.score, 0);
});

test('the arrow advances on a wrong press too', () => {
    // Press 0 is wrong. Press 1 is the right arrow for position 1, so scores.
    const inputs: Input[] = [
        { direction: wrongFor(STREAM[0]!), atMs: 10 },
        { direction: STREAM[1]!, atMs: 60 }
    ];
    assert.equal(simulateRace([racer('a', inputs), racer('b', [])])[0]!.score, 1);
});

test('a player GAP points behind the leader is crushed, at that moment', () => {
    // 'a' scores every 100 ms; 'b' never scores. 'b' falls GAP behind when a hits GAP.
    const outcomes = simulateRace([
        racer('a', presses(20, 100)),
        racer('b', presses(20, 100, () => false))
    ]);
    assert.equal(outcomeOf(outcomes, 'b').eliminatedAtMs, GAP * 100);
    assert.equal(outcomeOf(outcomes, 'b').score, 0);
});

test('one point short of the gap is still alive, until the gap narrows', () => {
    // b sits GAP - 1 behind from 700 ms. That is safe while the gap is 8, but
    // the gap narrows to 7 at 20 s and b is crushed right then.
    const outcomes = simulateRace([racer('a', presses(GAP - 1, 100)), racer('b', [])]);
    assert.equal(outcomeOf(outcomes, 'b').eliminatedAtMs, CRUSHER_ESCALATOR.GAP_SHRINK_STARTS_MS);
});

test('the race ends when one player is left, so later presses are ignored', () => {
    const outcomes = simulateRace([racer('a', presses(30, 100)), racer('b', [])]);
    // b is crushed at 800 ms; a's later presses must not add to the score.
    assert.equal(outcomeOf(outcomes, 'a').score, GAP);
    assert.equal(outcomeOf(outcomes, 'a').eliminatedAtMs, null);
});

test('an eliminated player stops scoring', () => {
    const outcomes = simulateRace([
        racer('a', presses(30, 100)),
        racer('b', presses(30, 100, () => false)),
        racer('c', presses(30, 100, (i) => i < 5)) // 5 right, then wrong
    ]);
    assert.equal(outcomeOf(outcomes, 'b').eliminatedAtMs, GAP * 100);
    // c stalls on 5 points, so it is crushed once a reaches 5 + GAP.
    assert.equal(outcomeOf(outcomes, 'c').score, 5);
    assert.equal(outcomeOf(outcomes, 'c').eliminatedAtMs, (5 + GAP) * 100);
});

test('the leader is whoever has the highest score, and the lead can change hands', () => {
    // a leads early then stalls; b overtakes. c, stuck on 2, falls GAP behind b.
    const outcomes = simulateRace([
        racer('a', presses(4, 100)),
        racer('b', presses(20, 100, () => true, 500)),
        racer('c', presses(2, 100))
    ]);
    assert.equal(outcomeOf(outcomes, 'c').eliminatedAtMs !== null, true);
    assert.equal(outcomeOf(outcomes, 'b').eliminatedAtMs, null);
});

test('simultaneous presses are all counted before anyone is crushed', () => {
    // Both reach the gap over c at the same instant; neither order matters.
    const outcomes = simulateRace([
        racer('a', presses(GAP, 100)),
        racer('b', presses(GAP, 100)),
        racer('c', [])
    ]);
    const forward = outcomeOf(outcomes, 'c');
    const reversed = outcomeOf(
        simulateRace([racer('c', []), racer('b', presses(GAP, 100)), racer('a', presses(GAP, 100))]),
        'c'
    );
    assert.equal(forward.eliminatedAtMs, GAP * 100);
    assert.deepEqual(forward, reversed);
    // a and b are level on the lead, so both survive.
    assert.equal(outcomeOf(outcomes, 'a').eliminatedAtMs, null);
    assert.equal(outcomeOf(outcomes, 'b').eliminatedAtMs, null);
});

test('a lone reporter survives with their own score', () => {
    const outcomes = simulateRace([racer('solo', presses(3, 100))]);
    assert.equal(outcomes[0]!.eliminatedAtMs, null);
});

test('the gap narrowing crushes a player even when nobody presses', () => {
    // a is 6 ahead from early on, then everyone stops. At 20 s the gap is 7
    // (still safe); at 30 s it is 6, and b is crushed right then.
    const outcomes = simulateRace([racer('a', presses(6, 100)), racer('b', [])]);
    assert.equal(outcomeOf(outcomes, 'b').eliminatedAtMs, 30_000);
});

test('late in the race a small lead is enough to crush', () => {
    // From 60 s the gap is 3. a scores 3 quick points after b has stopped.
    const outcomes = simulateRace([
        racer('a', presses(3, 100, () => true, 61_000)),
        racer('b', [])
    ]);
    assert.equal(outcomeOf(outcomes, 'b').eliminatedAtMs, 61_300);
});

/* ---------------- module: round data, ranking, parsing ---------------- */

test('round data gives each player their own seed, and nothing else', () => {
    const round = crusherEscalatorModule.createRoundData({
        roundInGame: 1,
        roundsPerGame: 1,
        playerIds: ['a', 'b', 'c'],
        attempt: 0
    });
    assert.deepEqual(Object.keys(round), ['seeds']);
    assert.deepEqual(Object.keys(round.seeds), ['a', 'b', 'c']);
    assert.notEqual(round.seeds.a, round.seeds.b);
});

test('every player count races in a single group: there are no heats', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const round = crusherEscalatorModule.createRoundData({
        roundInGame: 1,
        roundsPerGame: 2,
        playerIds: ids,
        attempt: 0
    });
    assert.equal(Object.keys(round.seeds).length, 12);
    assert.equal(crusherEscalatorModule.nextStage, undefined);
    assert.equal(crusherEscalatorModule.openingTiming, undefined);
});

test('Crusher Escalator gives 4 seconds for the ending animation', () => {
    assert.equal(crusherEscalatorModule.finishAnimationMs, 4_000);
});

test('Crusher Escalator is played for 2 scoring rounds', () => {
    assert.equal(crusherEscalatorModule.roundsPerGame, 2);
});

const roundWith = (ids: string[]): CrusherEscalatorRound => ({
    seeds: Object.fromEntries(ids.map((id, i) => [id, 1_000 + i]))
});

/** Presses against the player's real sequence in `round`. */
const pressesIn = (
    round: CrusherEscalatorRound,
    playerId: string,
    count: number,
    stepMs: number,
    isRight?: (pressIndex: number) => boolean
): Input[] => presses(count, stepMs, isRight, 0, arrowSequence(round.seeds[playerId]!));

const result = (inputs: Input[]) => ({ inputs, timingSuspect: false });

test('rank judges presses against each player\'s seeded sequence', () => {
    const round = roundWith(['early', 'winner', 'late']);
    const ranked = crusherEscalatorModule.rank(
        [
            { playerId: 'early', result: result([]) },
            { playerId: 'winner', result: result(pressesIn(round, 'winner', 40, 100)) },
            { playerId: 'late', result: result(pressesIn(round, 'late', 40, 100, (i) => i < 6)) }
        ],
        round
    );
    assert.deepEqual(
        ranked.map((row) => [row.playerId, row.rank]),
        [['winner', 1], ['late', 2], ['early', 3]]
    );
    assert.equal(ranked[0]!.detail.survived, true);
    assert.equal(ranked[2]!.detail.survived, false);
    assert.equal(ranked[2]!.detail.eliminatedAtMs, GAP * 100);
});

test('rank ignores the order results arrived in (latency cannot change the winner)', () => {
    const round = roundWith(['a', 'b']);
    const entries = [
        { playerId: 'a', result: result(pressesIn(round, 'a', 40, 100)) },
        { playerId: 'b', result: result(pressesIn(round, 'b', 40, 130)) }
    ];
    assert.deepEqual(
        crusherEscalatorModule.rank(entries, round),
        crusherEscalatorModule.rank([...entries].reverse(), round)
    );
});

test('equal scores at the time cap share rank 1, which triggers a tiebreaker', () => {
    const round = roundWith(['a', 'b']);
    const ranked = crusherEscalatorModule.rank(
        [
            { playerId: 'a', result: result(pressesIn(round, 'a', 5, 100)) },
            { playerId: 'b', result: result(pressesIn(round, 'b', 5, 100)) }
        ],
        round
    );
    assert.deepEqual(ranked.map((row) => row.rank), [1, 1]);
});

test('closing early: once all but one have reported, the last is told to stop', () => {
    const close = crusherEscalatorModule.shouldCloseEarly!;
    const round = roundWith(['a', 'b', 'c']);
    assert.equal(close([result([])], 3, round), false);
    assert.equal(close([result([]), result([])], 3, round), true);
});

test('parseResult accepts well-formed presses and rejects bad ones', () => {
    const ok = parseCrusherEscalatorResult({
        inputs: [{ direction: 'up', atMs: 10.4 }, { direction: 'left', atMs: 80.6 }],
        timingSuspect: true
    });
    assert.deepEqual(ok?.inputs, [
        { direction: 'up', atMs: 10 },
        { direction: 'left', atMs: 81 }
    ]);
    assert.equal(ok?.timingSuspect, true);

    const bad: unknown[] = [
        null,
        {},
        { inputs: 'x' },
        { inputs: [{ direction: 'forward', atMs: 1 }] },
        { inputs: [{ direction: 'up', atMs: -1 }] },
        { inputs: [{ direction: 'up', atMs: CRUSHER_ESCALATOR.MAX_RACE_MS + 1 }] },
        { inputs: [{ direction: 'up', atMs: 50 }, { direction: 'down', atMs: 40 }] },
        { inputs: Array(CRUSHER_ESCALATOR.MAX_INPUTS + 1).fill({ direction: 'up', atMs: 1 }) }
    ];
    for (const raw of bad) assert.equal(parseCrusherEscalatorResult(raw), null);
});

test('presses closer together than the minimum interval are spaced out, not rejected', () => {
    const parsed = parseCrusherEscalatorResult({
        inputs: [
            { direction: 'up', atMs: 100 },
            { direction: 'down', atMs: 110 }, // rolled two keys: moved to 150
            { direction: 'left', atMs: 120 }, // reported after 110, so in order: moved to 200
            { direction: 'right', atMs: 500 } // far enough apart: untouched
        ]
    });
    assert.deepEqual(
        parsed?.inputs.map((input) => input.atMs),
        [100, 100 + MIN_INTERVAL, 100 + 2 * MIN_INTERVAL, 500]
    );
});

test('a burst stamped at one instant cannot crush everyone at once', () => {
    const round = roundWith(['burst', 'a', 'b']);
    const arrows = arrowSequence(round.seeds.burst!);
    const burst = parseCrusherEscalatorResult({
        inputs: Array.from({ length: 20 }, (_, i) => ({ direction: arrows(i), atMs: 1 }))
    })!;
    // Spaced out, the burst's 8th point lands at 1 + 7 * 50 ms, not at 1 ms.
    const ranked = crusherEscalatorModule.rank(
        [
            { playerId: 'burst', result: burst },
            { playerId: 'a', result: result([]) },
            { playerId: 'b', result: result([]) }
        ],
        round
    );
    const crushedAt = ranked.filter((row) => !row.detail.survived).map((row) => row.detail.eliminatedAtMs);
    assert.deepEqual(crushedAt, [1 + (GAP - 1) * MIN_INTERVAL, 1 + (GAP - 1) * MIN_INTERVAL]);
});

test('presses spaced past the end of the race are dropped', () => {
    const end = CRUSHER_ESCALATOR.MAX_RACE_MS;
    const parsed = parseCrusherEscalatorResult({
        inputs: [
            { direction: 'up', atMs: end - 10 },
            { direction: 'down', atMs: end }
        ]
    });
    assert.deepEqual(parsed?.inputs, [{ direction: 'up', atMs: end - 10 }]);
});

test('parseProgress accepts a whole-number score only', () => {
    assert.deepEqual(parseCrusherEscalatorProgress({ score: 7 }), { score: 7 });
    assert.equal(parseCrusherEscalatorProgress({ score: -1 }), null);
    assert.equal(parseCrusherEscalatorProgress({ score: 1.5 }), null);
    assert.equal(parseCrusherEscalatorProgress({}), null);
});
