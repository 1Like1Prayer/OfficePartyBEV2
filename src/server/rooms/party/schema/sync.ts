/**
 * Small helpers for writing plain values into schema collections without
 * producing patches when nothing changed.
 */

import type { ArraySchema, MapSchema } from '@colyseus/schema';

/** Make `target` hold exactly `items`, in order. No-op when already equal. */
export const replaceArray = <T>(target: ArraySchema<T>, items: readonly T[]): void => {
    const unchanged =
        target.length === items.length && items.every((item, index) => target.at(index) === item);
    if (unchanged) return;
    target.clear();
    target.push(...items);
};

/** Make `target` hold exactly the entries of `record`. */
export const replaceMap = <T>(target: MapSchema<T>, record: Readonly<Record<string, T>>): void => {
    for (const key of [...target.keys()]) {
        if (!(key in record)) target.delete(key);
    }
    for (const [key, value] of Object.entries(record)) {
        if (target.get(key) !== value) target.set(key, value);
    }
};
