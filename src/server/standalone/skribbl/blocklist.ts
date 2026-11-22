/**
 * Words never offered to a drawer, because they don't suit an office. Edit
 * freely: entries are matched ignoring case, spaces and punctuation, and the
 * list applies on the next server start (no rebuild of words.ts needed).
 * A test fails if an entry matches no word, so typos don't slip through.
 */

export const SKRIBBL_BLOCKLIST: readonly string[] = [
    // Sexual, drugs or crude
    'tampon',
    'stoned',
    'turd',
    'butt cheeks',
    // Religion and politics
    'Jesus Christ',
    'God',
    'Donald Trump',
    'Kim Jong-un',
    'North Korea',
    'communism',
    // Sensitive about people
    'murderer',
    'homeless',
    'handicap',
    'minority',
    'depressed',
    'overweight',
    'eskimo'
];
