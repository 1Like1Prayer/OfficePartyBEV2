import test from 'node:test';
import assert from 'node:assert/strict';
import type { SharedWorld } from '../selfTimed.js';
import { MAGE_BATTLE } from './constants.js';
import {
    advanceTo,
    angleAt,
    blockCountOf,
    blocksOf,
    pressDial,
    speedOf,
    spinEndsAtMs,
    startDial,
    zoneLead
} from './dial.js';
import { dialKey, handlePress, mageBattleModule, readBattleBar, readDial } from './module.js';
import { battleBar, dueForKnockout } from './progress.js';
import { parseMageBattleResult, parsePressAction } from './parsing.js';
import type { Dial, MageBattleRound } from './types.js';

const SEED = 12345;

/** The moment the dial is over the middle of the block worth `points` (or a gap, for 0). */
const timeFor = (dial: Dial, points: number): number => {
    const block = blocksOf(dial.level).find((each) => each.points === points);
    const offset = block === undefined ? -20 : (block.fromDeg + block.toDeg) / 2;
    return dial.sinceMs + ((dial.zone + offset) / speedOf(dial.level)) * 1000;
};

/** The dial once its current spin is over. */
const nextSpin = (dial: Dial, playerId = 'a'): Dial => advanceTo(dial, spinEndsAtMs(dial), SEED, playerId);

/** Presses on the block worth `points` this spin. */
const press = (dial: Dial, points: number, playerId = 'a') => pressDial(dial, timeFor(dial, points), SEED, playerId);

/** Hits the smallest block in each of `times` spins, ending at the start of the next spin. */
const hits = (times: number, from = startDial(SEED, 'a')): Dial => {
    let dial = from;
    for (let step = 0; step < times; step++) dial = nextSpin(press(dial, 4).dial);
    return dial;
};

/* ---------------- the dial ---------------- */

test('four blocks down to one, and up to 140% speed: the last block speeds up twice', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map(blockCountOf), [4, 3, 2, 1, 1]);
    assert.deepEqual([0, 1, 2, 3, 4].map((level) => Math.round((speedOf(level) / speedOf(0)) * 100)), [100, 110, 120, 130, 140]);
    // The biggest go first: what is left is always the smallest.
    assert.deepEqual(blocksOf(0).map(({ points }) => points), [1, 2, 3, 4]);
    assert.deepEqual(blocksOf(2).map(({ points }) => points), [3, 4]);
    assert.deepEqual(blocksOf(4).map(({ points }) => points), [4]);
    const widths = blocksOf(0).map(({ fromDeg, toDeg }) => toDeg - fromDeg);
    assert.deepEqual([...widths].sort((a, b) => b - a), widths, 'biggest to smallest');
});

test('each block scores its own points at once, and a press off the blocks scores nothing', () => {
    const dial = startDial(SEED, 'a');
    for (const points of [1, 2, 3, 4]) {
        const pressed = press(dial, points);
        assert.equal(pressed.points, points);
        assert.equal(pressed.dial.score, points);
    }
    assert.equal(press(dial, 0).points, 0);
});

test('only the first press of a spin counts', () => {
    const missed = press(startDial(SEED, 'a'), 0).dial;
    const again = press(missed, 4);
    assert.equal(again.counted, false);
    assert.equal(again.points, 0);
    assert.equal(again.dial, missed, 'nothing changed');
    // The next spin takes a press again.
    assert.equal(press(nextSpin(missed), 4).counted, true);
});

test('the speed changes when the next spin starts, not mid-spin', () => {
    const pressed = press(startDial(SEED, 'a'), 4).dial;
    assert.equal(pressed.level, 0);
    assert.equal(nextSpin(pressed).level, 1);
});

test('hits speed the dial up a level a spin and add up; it stops at the top speed', () => {
    const dial = hits(6);
    assert.equal(dial.level, MAGE_BATTLE.MAX_LEVEL);
    assert.equal(dial.score, 24);
    assert.equal(dial.spin, 6);
});

test('a miss slows down a level and brings a block back, but not below the start', () => {
    assert.equal(nextSpin(press(hits(2), 0).dial).level, 1);
    assert.equal(nextSpin(press(startDial(SEED, 'a'), 0).dial).level, 0);
    assert.equal(press(hits(2), 0).dial.score, 8, 'a miss costs no points');
});

test('a miss at 140% drops back to 120% and two blocks', () => {
    const dial = nextSpin(press(hits(4), 0).dial);
    assert.equal(dial.level, 2);
    assert.equal(blockCountOf(dial.level), 2);
    // At 130% (one block) a miss lands in the same place.
    assert.equal(nextSpin(press(hits(3), 0).dial).level, 2);
});

test('a spin without a press is a miss', () => {
    const fast = hits(2);
    const end = spinEndsAtMs(fast);
    assert.equal(advanceTo(fast, end - 1, SEED, 'a'), fast, 'not over yet');
    const missed = advanceTo(fast, end, SEED, 'a');
    assert.equal(missed.level, 1);
    assert.equal(missed.spin, 3);
    assert.equal(missed.sinceMs, end);
    // Two spins idle: two misses.
    assert.equal(advanceTo(fast, spinEndsAtMs(missed), SEED, 'a').level, 0);
});

test('a press after an idle spin plays the miss first', () => {
    const dial = hits(2);
    const { dial: after, points } = press(nextSpin(dial), 4);
    const direct = pressDial(dial, timeFor(nextSpin(dial), 4), SEED, 'a');
    assert.equal(points, 4);
    assert.deepEqual(direct.dial, after);
    assert.equal(nextSpin(after).level, 2, 'down one for the idle spin, up one for the hit');
});

test('every spin starts at the top, and its blocks sit ahead of the dial and inside the spin', () => {
    const dial = hits(3);
    assert.ok(Math.abs(angleAt(dial, dial.sinceMs)) < 1e-9);
    const span = blocksOf(0).at(-1)!.toDeg;
    const leads = new Set<number>();
    for (let spin = 0; spin < 200; spin++) {
        const lead = zoneLead(SEED, 'a', spin);
        leads.add(Math.round(lead));
        assert.ok(lead >= MAGE_BATTLE.ZONE_MIN_LEAD_DEG && lead <= MAGE_BATTLE.ZONE_MAX_LEAD_DEG);
        assert.ok(lead + span < 360);
    }
    assert.ok(leads.size > 50, 'spread out');
    assert.notEqual(zoneLead(SEED, 'a', 0), zoneLead(SEED, 'b', 0), 'each mage has their own');
});

/* ---------------- presses on the server ---------------- */

const round: MageBattleRound = { seed: SEED, playerIds: ['a', 'b', 'c'] };

const worldAt = (raceMs: number, values: Record<string, number> = {}): SharedWorld & { values: Record<string, number> } => {
    const world = {
        raceMs,
        values,
        get: (key: string) => values[key],
        set: (key: string, value: number) => { values[key] = value; }
    };
    return world;
};

/**
 * Presses for `playerId` right on the block worth `points`, in their next
 * unpressed spin, with the server's clock there too.
 */
const serverPress = (values: Record<string, number>, playerId: string, points: number) => {
    const stored = readDial(worldAt(0, values), round, playerId);
    const dial = stored.pressPoints === null ? stored : nextSpin(stored, playerId);
    const atMs = timeFor(dial, points);
    return handlePress(round, playerId, { type: 'press', atMs }, worldAt(atMs, values))!;
};

test('the server scores a press from the dial, and publishes it', () => {
    const values: Record<string, number> = {};
    const reply = serverPress(values, 'a', 3);
    assert.equal(reply.points, 3);
    assert.equal(values[dialKey('a', 'score')], 3);
    assert.equal(values[dialKey('a', 'level')], 0, 'faster from the next spin');
    assert.equal(values[dialKey('a', 'pressPoints')], 3);
    assert.deepEqual(readDial(worldAt(0, values), round, 'a'), reply.dial);
});

test('seven points behind the leader is out; a knocked-out mage scores no more', () => {
    const values: Record<string, number> = {};
    serverPress(values, 'b', 2);
    assert.deepEqual(serverPress(values, 'a', 4).eliminated, [], 'a 4, b 2, c 0');
    // a 7: c is seven behind, b only five.
    const third = serverPress(values, 'a', 3);
    assert.deepEqual(third.eliminated, ['c']);
    assert.equal(values[dialKey('c', 'outAtMs')], third.dial.pressedAtMs);

    const after = serverPress(values, 'c', 4);
    assert.equal(after.counted, false);
    assert.equal(after.points, 0);
    assert.equal(values[dialKey('c', 'score')], undefined, 'nothing written for them');
});

test('a miss never knocks anyone out, and the knocked-out stay out', () => {
    const values: Record<string, number> = {};
    serverPress(values, 'a', 4);
    assert.deepEqual(serverPress(values, 'b', 0).eliminated, []);
    assert.deepEqual(serverPress(values, 'a', 3).eliminated, ['b', 'c'], 'a 7, both still on 0');
    assert.deepEqual(serverPress(values, 'a', 4).eliminated, [], 'not knocked out twice');
});

test('a late press counts as 250 ms late at most; one from the future is refused', () => {
    assert.equal(MAGE_BATTLE.MAX_PRESS_LAG_MS, 250);
    const dial = startDial(SEED, 'a');
    const atMs = timeFor(dial, 4);
    // Within the cap: scored where it happened.
    assert.equal(handlePress(round, 'a', { type: 'press', atMs }, worldAt(atMs + 200))!.points, 4);
    // Reported a second after it happened: taken as 250 ms ago, by then off the blocks.
    const late = handlePress(round, 'a', { type: 'press', atMs }, worldAt(atMs + 1_000))!;
    assert.equal(late.dial.pressedAtMs, atMs + 1_000 - MAGE_BATTLE.MAX_PRESS_LAG_MS);
    assert.equal(late.points, 0);
    assert.equal(
        handlePress(round, 'b', { type: 'press', atMs: 2_000 }, worldAt(2_000 - MAGE_BATTLE.MAX_PRESS_LEAD_MS - 1)),
        null
    );
});

test('a second press in the same spin is ignored by the server too', () => {
    const values: Record<string, number> = {};
    const first = serverPress(values, 'a', 0);
    const atMs = first.dial.pressedAtMs! + 50;
    const second = handlePress(round, 'a', { type: 'press', atMs }, worldAt(atMs, values))!;
    assert.equal(second.counted, false);
    assert.deepEqual(readDial(worldAt(0, values), round, 'a'), first.dial);
});

test('a press cannot land in a spin the server has already moved past', () => {
    const values: Record<string, number> = {};
    serverPress(values, 'a', 4);
    const second = serverPress(values, 'a', 4);
    // Stamped back in the first spin: taken as the start of the spin they are in now.
    const reply = handlePress(round, 'a', { type: 'press', atMs: 0 }, worldAt(second.dial.pressedAtMs!, values))!;
    assert.equal(reply.counted, false);
    assert.equal(reply.dial.spin, second.dial.spin);
});

test('malformed presses and strangers are refused', () => {
    for (const raw of [null, 'press', { type: 'press' }, { type: 'press', atMs: -1 }, { type: 'press', atMs: MAGE_BATTLE.ROUND_MS + 1 }, { type: 'cast', atMs: 0 }]) {
        assert.equal(handlePress(round, 'a', raw, worldAt(0)), null, JSON.stringify(raw));
    }
    assert.equal(handlePress(round, 'stranger', { type: 'press', atMs: 0 }, worldAt(0)), null);
    assert.deepEqual(parsePressAction({ type: 'press', atMs: 1_234.5 }), { type: 'press', atMs: 1_234.5 });
    assert.deepEqual(parseMageBattleResult({}), { timingSuspect: false });
    assert.equal(parseMageBattleResult(null), null);
});

/* ---------------- the round ---------------- */

const reported = (...playerIds: string[]) =>
    playerIds.map((playerId) => ({ playerId, result: { timingSuspect: false } }));

const standings = (entries: Record<string, { score: number; outAtMs?: number }>): SharedWorld => {
    const values: Record<string, number> = {};
    for (const [playerId, { score, outAtMs }] of Object.entries(entries)) {
        values[dialKey(playerId, 'spin')] = 1;
        values[dialKey(playerId, 'score')] = score;
        if (outAtMs !== undefined) values[dialKey(playerId, 'outAtMs')] = outAtMs;
    }
    return worldAt(0, values);
};

test('the last mage standing wins, then whoever lasted longest, then the higher score', () => {
    const world = standings({ a: { score: 3, outAtMs: 20_000 }, b: { score: 10 }, c: { score: 1, outAtMs: 9_000 }, d: { score: 2, outAtMs: 20_000 } });
    const ranked = mageBattleModule.rank(reported('a', 'b', 'c', 'd'), round, world);
    assert.deepEqual(ranked.map(({ playerId, rank }) => [playerId, rank]), [['b', 1], ['a', 2], ['d', 3], ['c', 4]]);
    assert.equal(ranked[0]!.detail.score, 10);
    assert.equal(ranked[0]!.detail.survived, true);
});

test('after 60 seconds the highest score wins; level scores are a tie', () => {
    const ranked = mageBattleModule.rank(reported('a', 'b', 'c'), round, standings({ a: { score: 5 }, b: { score: 9 }, c: { score: 9 } }));
    assert.deepEqual(ranked.map(({ playerId, rank }) => [playerId, rank]), [['b', 1], ['c', 1], ['a', 3]]);
});

test('the round closes once one mage is left, and not before', () => {
    const close = (world: SharedWorld, playerIds = round.playerIds) =>
        mageBattleModule.shouldCloseEarly!([], playerIds.length, { ...round, playerIds }, world);
    assert.equal(close(standings({ a: { score: 7 }, b: { score: 2 }, c: { score: 0, outAtMs: 1 } })), false);
    assert.equal(close(standings({ a: { score: 9 }, b: { score: 2, outAtMs: 2 }, c: { score: 0, outAtMs: 1 } })), true);
    assert.equal(close(standings({ a: { score: 9 } }), ['a']), false, 'a lone mage plays the clock out');
});

/* ---------------- the battle bar ---------------- */

const standing = (playerId: string, score: number, out = false) => ({ playerId, score, out });

test('the bar runs from the knock-out line to the leader, one section per point', () => {
    const bar = battleBar([standing('a', 10), standing('b', 7), standing('c', 4)]);
    assert.equal(bar.leaderScore, 10);
    assert.equal(bar.knockoutScore, 10 - MAGE_BATTLE.ELIMINATION_GAP);
    assert.equal(bar.checkpoints.length, MAGE_BATTLE.ELIMINATION_GAP - 1);
    assert.equal(bar.checkpoints.at(-1), (MAGE_BATTLE.ELIMINATION_GAP - 1) / MAGE_BATTLE.ELIMINATION_GAP);
    const [a, b, c] = bar.markers;
    assert.deepEqual([a!.fractionOfBar, a!.behindLeader, a!.margin, a!.pointsToKnockout], [1, 0, 3, 7]);
    assert.deepEqual([b!.fractionOfBar, b!.behindLeader, b!.margin, b!.pointsToKnockout], [4 / 7, 3, -3, 4]);
    assert.deepEqual([c!.fractionOfBar, c!.behindLeader, c!.margin, c!.pointsToKnockout], [1 / 7, 6, -6, 1]);
});

test('everyone starts level at the leader\'s end, and level leaders share it', () => {
    const start = battleBar([standing('a', 0), standing('b', 0)]);
    assert.deepEqual(start.markers.map(({ fractionOfBar, margin }) => [fractionOfBar, margin]), [[1, 0], [1, 0]]);
    const level = battleBar([standing('a', 5), standing('b', 5), standing('c', 1)]);
    assert.deepEqual(level.markers.map(({ playerId, behindLeader }) => [playerId, behindLeader]), [['a', 0], ['b', 0], ['c', 4]]);
});

test('the knocked-out sit on the line, last, and no longer set the leader\'s mark', () => {
    const bar = battleBar([standing('a', 12, true), standing('b', 5), standing('c', 3)]);
    assert.equal(bar.leaderScore, 5, 'a high score from someone out does not count');
    assert.deepEqual(bar.markers.map(({ playerId }) => playerId), ['b', 'c', 'a']);
    assert.deepEqual([bar.markers[2]!.fractionOfBar, bar.markers[2]!.pointsToKnockout], [0, 0]);
    assert.equal(bar.markers[0]!.margin, 2, 'ahead of the best still fighting');
});

test('a marker reaching the line is exactly who the server knocks out', () => {
    const standings = [standing('a', 9), standing('b', 2), standing('c', 3), standing('d', 0, true)];
    assert.deepEqual(dueForKnockout(standings), ['b']);
    const atLine = battleBar(standings).markers.filter(({ out, fractionOfBar }) => !out && fractionOfBar === 0);
    assert.deepEqual(atLine.map(({ playerId }) => playerId), ['b']);
});

test('the bar read from the world follows the presses', () => {
    const values: Record<string, number> = {};
    serverPress(values, 'a', 4);
    serverPress(values, 'b', 1);
    const bar = readBattleBar(worldAt(0, values), round);
    assert.deepEqual(bar.markers.map(({ playerId, score, margin }) => [playerId, score, margin]), [['a', 4, 3], ['b', 1, -3], ['c', 0, -4]]);
});
