/**
 * The word list a drawer picks from: clean, unique, filtered, and fairly drawn.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeGuess } from '../../src/shared/standalone/skribbl/guess.js';
import { letterIndexes } from '../../src/shared/standalone/skribbl/hints.js';
import { SKRIBBL_BLOCKLIST } from '../../src/server/standalone/skribbl/blocklist.js';
import { SKRIBBL_WORDS } from '../../src/server/standalone/skribbl/words.js';
import { playableWords, WordBank } from '../../src/server/standalone/skribbl/wordBank.js';

describe('skribbl words', () => {
    it('has no two words a guess could not tell apart, and every word is guessable', () => {
        const firstByKey = new Map<string, string>();
        const clashes: string[] = [];
        for (const word of SKRIBBL_WORDS) {
            const key = normalizeGuess(word);
            const first = firstByKey.get(key);
            if (first === undefined) firstByKey.set(key, word);
            else clashes.push(`"${word}" (same as "${first}")`);
        }
        assert.deepEqual(clashes, [], `duplicate words: ${clashes.join(', ')}`);
        for (const word of SKRIBBL_WORDS) {
            assert.equal(word, word.trim());
            assert.ok(letterIndexes(word).length >= 2, `"${word}" is too short to draw`);
        }
    });

    it('filters out every blocklisted word, and each blocklist entry matches a real word', () => {
        const keys = new Set(SKRIBBL_WORDS.map(normalizeGuess));
        for (const entry of SKRIBBL_BLOCKLIST) assert.ok(keys.has(normalizeGuess(entry)), `"${entry}" matches no word`);
        const playable = new Set(playableWords().map(normalizeGuess));
        for (const entry of SKRIBBL_BLOCKLIST) assert.ok(!playable.has(normalizeGuess(entry)), `"${entry}" is still playable`);
        assert.equal(playableWords().length, SKRIBBL_WORDS.length - SKRIBBL_BLOCKLIST.length);
    });

    it('offers different words each time in a game, and starts over when they run out', () => {
        const bank = new WordBank(['a1', 'b2', 'c3', 'd4'], () => 0);
        assert.deepEqual(bank.choices(3), ['a1', 'b2', 'c3']);
        assert.deepEqual(bank.choices(3), ['a1', 'b2', 'c3'], 'only one fresh word left, so the bank starts over');
        bank.reset();
        assert.deepEqual(bank.choices(2), ['a1', 'b2']);
        assert.deepEqual(bank.choices(2), ['c3', 'd4']);
    });
});
