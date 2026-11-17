import test from 'node:test';
import assert from 'node:assert/strict';
import { seededRandom } from '../random.js';
import type { SharedWorld } from '../selfTimed.js';
import { isOnTile, LAYER_COUNT, layerHeight, TILES, TOP_TILES } from './arena.js';
import { HEX_DROP } from './constants.js';
import { createRoundData, handleTouch, hexDropModule } from './module.js';
import { startState, stepRunner, type Controls, type RunnerState } from './movement.js';
import { parseHexDropProgress, parseHexDropResult } from './parsing.js';
import type { HexDropResult, Tile } from './types.js';

const SQRT3 = Math.sqrt(3);
const everyTile = () => true;

/** Runs `steps` steps with the controls the callback picks for each. */
const run = (
    state: RunnerState,
    steps: number,
    controls: (state: RunnerState, step: number) => Controls,
    isStanding: (tile: Tile) => boolean = everyTile
): RunnerState => {
    let current = state;
    for (let step = 0; step < steps; step++) current = stepRunner(current, controls(current, step), isStanding);
    return current;
};

const towards = (from: Tile, to: Tile, jump = false): Controls => {
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    return { moveX: (to.x - from.x) / length, moveZ: (to.z - from.z) / length, jump };
};

const still: Controls = { moveX: 0, moveZ: 0, jump: false };

/** Two top tiles next to each other on the ring. */
const [first, second] = [TOP_TILES[0]!, TOP_TILES[1]!];

/* ---------------- the arena ---------------- */

test('four layers: a top ring of 12, then three solid floors, each wider than the last', () => {
    assert.equal(LAYER_COUNT, 4);
    assert.equal(TOP_TILES.length, 12);
    const counts = Array.from({ length: LAYER_COUNT }, (_, layer) => TILES.filter((tile) => tile.layer === layer).length);
    assert.deepEqual(counts, [12, 61, 91, 127]);

    const reach = (layer: number) =>
        Math.max(...TILES.filter((tile) => tile.layer === layer).map((tile) => Math.hypot(tile.x, tile.z)));
    for (let layer = 1; layer < LAYER_COUNT; layer++) assert.ok(reach(layer) > reach(layer - 1), `layer ${layer}`);
});

test('the top tiles have gaps between them; the floors below have none', () => {
    const touching = HEX_DROP.TILE_RADIUS * SQRT3;
    const nearest = (tile: Tile) =>
        Math.min(
            ...TILES.filter((other) => other.layer === tile.layer && other !== tile).map((other) =>
                Math.hypot(other.x - tile.x, other.z - tile.z)
            )
        );
    for (const tile of TOP_TILES) assert.ok(nearest(tile) > touching + 1, 'a real gap to jump');
    for (const tile of TILES.filter((tile) => tile.layer > 0)) {
        assert.ok(Math.abs(nearest(tile) - touching) < 1e-9, 'edge to edge with a neighbour');
    }
});

test('the tile test follows the hexagon\'s shape', () => {
    const tile = TILES.find((each) => each.layer === 1 && each.x === 0 && each.z === 0)!;
    const inner = (HEX_DROP.TILE_RADIUS * SQRT3) / 2;
    assert.ok(isOnTile(tile, 0, 0));
    assert.ok(isOnTile(tile, inner - 0.01, 0), 'just inside the flat side');
    assert.ok(!isOnTile(tile, inner + 0.01, 0), 'just outside it');
    assert.ok(isOnTile(tile, 0, HEX_DROP.TILE_RADIUS - 0.01), 'just inside the point');
    assert.ok(!isOnTile(tile, inner - 0.01, HEX_DROP.TILE_RADIUS - 0.01), 'outside the corner');
});

/* ---------------- moving ---------------- */

test('standing still on a tile stays put', () => {
    const end = run(startState(first), 120, () => still);
    assert.equal(end.tile, first.id);
    assert.equal(end.y, layerHeight(0));
});

test('walking off a top tile without jumping drops to the layer below', () => {
    // Walk until off the top layer, then stand wherever they land.
    const end = run(startState(first), 180, (state) => (state.layer === 0 ? towards(first, second) : still));
    assert.equal(end.layer, 1);
    assert.notEqual(end.tile, null);
    assert.equal(end.y, layerHeight(1));
});

test('jumping towards the next top tile reaches it', () => {
    const end = run(startState(first), 120, (state, step) =>
        state.tile === second.id ? still : towards(first, second, step === 1)
    );
    assert.equal(end.layer, 0);
    assert.equal(end.tile, second.id);
});

test('a tile that drops from under a runner drops them to the next layer', () => {
    let gone = false;
    const end = run(
        startState(first),
        120,
        (_state, step) => {
            if (step === 30) gone = true;
            return still;
        },
        (tile) => !(gone && tile.id === first.id)
    );
    assert.equal(end.layer, 1);
});

test('falling through every layer is out', () => {
    const end = run(startState(first), 600, () => still, () => false);
    assert.ok(end.out);
});

test('a jump pressed just before landing still stands on the tile for a moment', () => {
    // Drop onto layer 1 with jump held down the whole way: they must touch down before bouncing.
    const tiles: (number | null)[] = [];
    run(startState(first), 120, (state) => {
        tiles.push(state.tile);
        return { moveX: 0, moveZ: 0, jump: true };
    }, (tile) => tile.layer !== 0);
    assert.ok(tiles.some((tile) => tile !== null && TILES[tile]!.layer === 1));
});

test('diagonal running is no faster than straight', () => {
    const straight = run(startState(TILES.find((tile) => tile.layer === 3 && tile.x === 0 && tile.z === 0)!), 30, () => ({ moveX: 1, moveZ: 0, jump: false }));
    const diagonal = run(startState(TILES.find((tile) => tile.layer === 3 && tile.x === 0 && tile.z === 0)!), 30, () => ({ moveX: 1, moveZ: 1, jump: false }));
    assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.z) - straight.x) < 1e-9);
});

/* ---------------- tiles ---------------- */

const worldAt = (raceMs: number, values: Record<string, number> = {}): SharedWorld & { values: Record<string, number> } => ({
    raceMs,
    values,
    get: (key) => values[key],
    set: (key, value) => { values[key] = value; }
});

test('a touch makes the tile drop two seconds later, for everyone', () => {
    const world = worldAt(1_000);
    const fallAtMs = 900 + HEX_DROP.FALL_DELAY_MS;
    assert.deepEqual(handleTouch({ type: 'touch', tile: 5, atMs: 900 }, world), { tile: 5, fallAtMs });
    assert.deepEqual(world.values, { 5: fallAtMs });
});

test('the earliest touch decides, whatever order they arrive in', () => {
    const world = worldAt(2_000);
    handleTouch({ type: 'touch', tile: 5, atMs: 1_800 }, world);
    handleTouch({ type: 'touch', tile: 5, atMs: 1_500 }, world);
    handleTouch({ type: 'touch', tile: 5, atMs: 1_900 }, world);
    assert.equal(world.values['5'], 1_500 + HEX_DROP.FALL_DELAY_MS);
});

test('a very late touch counts as only a second late; one from the future is refused', () => {
    const world = worldAt(10_000);
    assert.equal(handleTouch({ type: 'touch', tile: 1, atMs: 2_000 }, world)?.fallAtMs, 9_000 + HEX_DROP.FALL_DELAY_MS);
    assert.equal(handleTouch({ type: 'touch', tile: 2, atMs: 11_000 }, world), null);
    assert.equal(world.values['2'], undefined);
});

test('malformed touches are refused', () => {
    const world = worldAt(1_000);
    for (const raw of [
        null,
        { type: 'touch', tile: -1, atMs: 0 },
        { type: 'touch', tile: TILES.length, atMs: 0 },
        { type: 'touch', tile: 1.5, atMs: 0 },
        { type: 'touch', tile: 1, atMs: 'soon' },
        { type: 'jump', tile: 1, atMs: 0 }
    ]) {
        assert.equal(handleTouch(raw, world), null, JSON.stringify(raw));
    }
});

/* ---------------- the round ---------------- */

test('every player starts on their own top tile, spread round the ring', () => {
    for (const count of [2, 3, 6, 12]) {
        const ids = Array.from({ length: count }, (_, i) => `p${i}`);
        const round = createRoundData({ playerIds: ids }, seededRandom(count));
        const spawns = ids.map((id) => round.spawns[id]!);
        assert.equal(new Set(spawns).size, count);
        for (const tile of spawns) assert.equal(TILES[tile]!.layer, 0);
    }
});

const entry = (playerId: string, outAtMs: number | null): { playerId: string; result: HexDropResult } => ({
    playerId,
    result: { outAtMs, timingSuspect: false }
});

test('the last one up wins, then whoever fell out last', () => {
    const ranked = hexDropModule.rank([entry('a', 5_000), entry('b', null), entry('c', 9_000)], { spawns: {} });
    assert.deepEqual(ranked.map(({ playerId, rank }) => [playerId, rank]), [['b', 1], ['c', 2], ['a', 3]]);
});

test('falling out at the same moment is a tie', () => {
    const ranked = hexDropModule.rank([entry('a', 5_000), entry('b', 5_000)], { spawns: {} });
    assert.deepEqual(ranked.map(({ rank }) => rank), [1, 1]);
});

test('two still up when the clock runs out are level, and go to a tiebreaker', () => {
    const ranked = hexDropModule.rank([entry('z', null), entry('a', null), entry('m', 3_000)], { spawns: {} });
    assert.deepEqual(ranked.map(({ playerId, rank }) => [playerId, rank]), [['a', 1], ['z', 1], ['m', 3]]);
});

test('once all but one have fallen out, the last one is told to stop', () => {
    const close = (reported: ReturnType<typeof entry>[], count: number) =>
        hexDropModule.shouldCloseEarly!(reported, count, { spawns: {} });
    assert.equal(close([entry('a', 1_000)], 3), false);
    assert.equal(close([entry('a', 1_000), entry('b', 2_000)], 3), true);
});

test('results and progress are checked', () => {
    assert.deepEqual(parseHexDropResult({ outAtMs: 1_234 }), { outAtMs: 1_234, timingSuspect: false });
    assert.deepEqual(parseHexDropResult({ outAtMs: null, timingSuspect: true }), { outAtMs: null, timingSuspect: true });
    assert.equal(parseHexDropResult({ outAtMs: -1 }), null);
    assert.equal(parseHexDropResult({ outAtMs: 1.5 }), null);
    assert.equal(parseHexDropResult({}), null);

    const ok = { t: 1_000, x: -250, y: 2_100, z: 300, out: 0 };
    assert.deepEqual(parseHexDropProgress(ok), ok);
    assert.equal(parseHexDropProgress({ ...ok, out: 2 }), null);
    assert.equal(parseHexDropProgress({ ...ok, x: 1.5 }), null);
    assert.equal(parseHexDropProgress({ ...ok, t: undefined }), null);
});
