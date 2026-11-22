/**
 * Picks the words a drawer chooses from. Server-only: the list never reaches
 * a browser. Within one game no word is offered twice, until the bank runs
 * dry and starts over.
 */

import { randomInt as cryptoRandomInt } from 'node:crypto';
import { normalizeGuess } from '../../../shared/standalone/skribbl/guess.js';
import { SKRIBBL_BLOCKLIST } from './blocklist.js';
import { SKRIBBL_WORDS } from './words.js';

/** `randomInt(n)` returns 0..n-1. */
export type RandomInt = (n: number) => number;

export const secureRandomInt: RandomInt = (n) => cryptoRandomInt(n);

/** The word list with blocked words removed. */
export const playableWords = (
    words: readonly string[] = SKRIBBL_WORDS,
    blocklist: readonly string[] = SKRIBBL_BLOCKLIST
): string[] => {
    const blocked = new Set(blocklist.map(normalizeGuess));
    return words.filter((word) => !blocked.has(normalizeGuess(word)));
};

export class WordBank {
    private offered = new Set<string>();

    constructor(
        private readonly words: readonly string[] = playableWords(),
        private readonly randomInt: RandomInt = secureRandomInt
    ) {
        if (words.length === 0) throw new Error('The Skribbl word list is empty.');
    }

    /** A new game: every word may be offered again. */
    reset(): void {
        this.offered.clear();
    }

    /** `count` different words not offered yet this game. */
    choices(count: number): string[] {
        const wanted = Math.min(count, this.words.length);
        let fresh = this.words.filter((word) => !this.offered.has(word));
        if (fresh.length < wanted) {
            this.offered.clear();
            fresh = [...this.words];
        }
        const picked: string[] = [];
        while (picked.length < wanted) {
            const [word] = fresh.splice(this.randomInt(fresh.length), 1);
            picked.push(word!);
        }
        for (const word of picked) this.offered.add(word);
        return picked;
    }
}
