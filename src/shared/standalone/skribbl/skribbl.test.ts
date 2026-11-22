import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CANVAS } from './constants.js';
import { CanvasModel, decodeDrawPacket, encodeDrawPacket, type CanvasOp } from './canvas.js';
import { editDistance, judgeGuess, normalizeGuess, revealsWord } from './guess.js';
import { hintCount, hintTimesMs, letterIndexes, pickHint, wordPattern } from './hints.js';
import { drawerPoints, guesserPoints } from './scoring.js';

describe('skribbl guesses', () => {
    it('compares letters and digits only, ignoring case, accents and punctuation', () => {
        assert.equal(normalizeGuess('  Mr. Bean! '), 'mrbean');
        assert.equal(normalizeGuess('Pokémon'), 'pokemon');
        assert.equal(judgeGuess('trex', 'T-rex'), 'correct');
        assert.equal(judgeGuess('AC DC', 'AC/DC'), 'correct');
        assert.equal(judgeGuess('polarbear', 'polar bear'), 'correct');
    });

    it('says close for one letter off, but never for short words or empty guesses', () => {
        assert.equal(judgeGuess('elefant', 'elephant'), 'wrong', 'two edits away');
        assert.equal(judgeGuess('elephnt', 'elephant'), 'close');
        assert.equal(judgeGuess('girafe', 'giraffe'), 'close');
        assert.equal(judgeGuess('cot', 'cat'), 'wrong', 'three-letter words are never close');
        assert.equal(judgeGuess('!!!', 'cat'), 'wrong');
        assert.equal(editDistance('kitten', 'sitting'), 3);
        assert.equal(editDistance('kitten', 'sitting', 1), 2, 'stops once past the limit');
    });

    it('spots a message that spells out the word', () => {
        assert.equal(revealsWord('it is a P-O-L-A-R bear!', 'polar bear'), true);
        assert.equal(revealsWord('a big white animal', 'polar bear'), false);
    });
});

describe('skribbl hints', () => {
    it('hides letters and digits, and shows spaces and punctuation from the start', () => {
        assert.equal(wordPattern('T-rex'), '_-___');
        assert.equal(wordPattern('skribbl.io'), '_______.__');
        assert.equal(wordPattern('ice cream', new Set([0, 4])), 'i__ c____');
        assert.deepEqual(letterIndexes('a b'), [0, 2]);
    });

    it('never reveals half the letters, and spaces hints evenly over the turn', () => {
        assert.equal(hintCount('cat', 3), 1);
        assert.equal(hintCount('ox', 3), 0);
        assert.equal(hintCount('elephant', 2), 2);
        assert.equal(hintCount('elephant', 9), 3);
        assert.deepEqual(hintTimesMs(2, 90_000), [30_000, 60_000]);
        assert.deepEqual(hintTimesMs(0, 90_000), []);
    });

    it('picks only hidden letters, and stops when none are left', () => {
        assert.equal(pickHint('a-b', new Set([0]), () => 0), 2);
        assert.equal(pickHint('ab', new Set([0, 1]), () => 0), null);
    });
});

describe('skribbl scoring', () => {
    it('rewards guessing early and guessing first', () => {
        assert.equal(guesserPoints(80_000, 80_000, 0), 500);
        assert.equal(guesserPoints(0, 80_000, 10), 50);
        assert.ok(guesserPoints(40_000, 80_000, 0) > guesserPoints(40_000, 80_000, 1));
        assert.ok(guesserPoints(60_000, 80_000, 1) > guesserPoints(20_000, 80_000, 1));
        assert.equal(guesserPoints(100_000, 80_000, 0), 500, 'clamped');
    });

    it('gives the drawer the guessers points shared over everyone who could guess', () => {
        assert.equal(drawerPoints([], 4), 0);
        assert.equal(drawerPoints([300, 300, 300], 4), 225);
        assert.equal(drawerPoints([400, 400], 2), 400);
    });
});

describe('skribbl canvas', () => {
    const ops: CanvasOp[] = [
        { op: 'begin', color: 3, size: 2, x: 10, y: 20 },
        { op: 'points', points: [{ x: 11, y: 21, dtMs: 16 }, { x: 799, y: 599, dtMs: 255 }] },
        { op: 'end' },
        { op: 'fill', color: 7, x: 400, y: 300 },
        { op: 'undo' },
        { op: 'clear' }
    ];

    it('round-trips every op through the binary format', () => {
        const bytes = encodeDrawPacket({ turnId: 123_456, ops });
        assert.equal(bytes.length, 5 + 7 + 12 + 1 + 6 + 1 + 1);
        assert.deepEqual(decodeDrawPacket(bytes), { turnId: 123_456, ops });
    });

    it('splits long strokes into ops of at most 255 points', () => {
        const points = Array.from({ length: 600 }, (_, i) => ({ x: i % 800, y: 1, dtMs: 0 }));
        const decoded = decodeDrawPacket(encodeDrawPacket({ turnId: 1, ops: [{ op: 'points', points }] }));
        assert.deepEqual(decoded?.ops.map((op) => (op.op === 'points' ? op.points.length : 0)), [255, 255, 90]);
    });

    it('refuses malformed packets as a whole', () => {
        const good = encodeDrawPacket({ turnId: 1, ops: [{ op: 'begin', color: 0, size: 0, x: 1, y: 1 }] });
        assert.equal(decodeDrawPacket(good.slice(0, good.length - 1)), null, 'truncated');
        assert.equal(decodeDrawPacket(new Uint8Array([2, 1, 0, 0, 0, 3])), null, 'wrong version');
        assert.equal(decodeDrawPacket(new Uint8Array([1, 1, 0, 0, 0, 99])), null, 'unknown op');
        assert.equal(decodeDrawPacket(new Uint8Array([1, 1, 0, 0, 0])), null, 'no ops');
        const offCanvas = encodeDrawPacket({ turnId: 1, ops: [{ op: 'fill', color: 0, x: CANVAS.WIDTH, y: 0 }] });
        assert.equal(decodeDrawPacket(offCanvas), null);
        const badColor = encodeDrawPacket({ turnId: 1, ops: [{ op: 'fill', color: CANVAS.PALETTE_SIZE, x: 0, y: 0 }] });
        assert.equal(decodeDrawPacket(badColor), null);
        const badSize = encodeDrawPacket({ turnId: 1, ops: [{ op: 'begin', color: 0, size: CANVAS.BRUSH_SIZES, x: 0, y: 0 }] });
        assert.equal(decodeDrawPacket(badSize), null);
    });

    it('keeps strokes and fills, undoes the last one, and clears', () => {
        const canvas = new CanvasModel();
        assert.equal(canvas.tryApply(ops.slice(0, 4)), true);
        assert.deepEqual(canvas.actionList.map((a) => a.kind), ['stroke', 'fill']);
        assert.equal(canvas.pointCount, 3);
        canvas.tryApply([{ op: 'undo' }]);
        assert.deepEqual(canvas.actionList.map((a) => a.kind), ['stroke']);
        canvas.tryApply([{ op: 'clear' }]);
        assert.equal(canvas.isEmpty, true);
        assert.equal(canvas.pointCount, 0);
    });

    it('refuses points with no stroke to add them to, without applying any of the packet', () => {
        const canvas = new CanvasModel();
        const accepted = canvas.tryApply([
            { op: 'fill', color: 1, x: 0, y: 0 },
            { op: 'points', points: [{ x: 1, y: 1, dtMs: 0 }] }
        ]);
        assert.equal(accepted, false);
        assert.equal(canvas.isEmpty, true);
    });

    it('refuses a packet that would take the turn past its limits', () => {
        const canvas = new CanvasModel({ maxActions: 2, maxPoints: 3 });
        const stroke = (n: number): CanvasOp[] => [
            { op: 'begin', color: 0, size: 0, x: 0, y: 0 },
            { op: 'points', points: Array.from({ length: n }, () => ({ x: 1, y: 1, dtMs: 0 })) }
        ];
        assert.equal(canvas.tryApply(stroke(3)), false, '4 points');
        assert.equal(canvas.tryApply(stroke(2)), true);
        assert.equal(canvas.tryApply([{ op: 'points', points: [{ x: 1, y: 1, dtMs: 0 }] }]), false);
        assert.equal(canvas.tryApply([{ op: 'undo' }, ...stroke(2)]), true, 'an undo frees room');
    });

    it('rebuilds the drawing as ops, leaving a stroke in progress open', () => {
        const canvas = new CanvasModel();
        canvas.tryApply([...ops.slice(0, 4), { op: 'begin', color: 1, size: 1, x: 5, y: 5 }]);
        const rebuilt = new CanvasModel();
        assert.equal(rebuilt.tryApply(canvas.toOps()), true);
        assert.deepEqual(rebuilt.actionList, canvas.actionList);
        // The drawer's next points carry on the open stroke.
        assert.equal(rebuilt.tryApply([{ op: 'points', points: [{ x: 6, y: 6, dtMs: 0 }] }]), true);
        assert.equal(canvas.toOps().at(-1)?.op, 'begin');
    });
});
