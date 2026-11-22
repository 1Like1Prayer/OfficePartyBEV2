/**
 * How a party room and the standalone game room it opened talk: the game
 * room tells the party when it closes, over Colyseus presence (in-process
 * here, Redis when scaled out), so the party lobby stops offering it.
 */

/** Options the party room creates a standalone game room with. */
export interface StandaloneCreateOptions {
    /** The party room that opened it. */
    partyCode: string;
    /** Whoever joins with this token owns the game room: the party's owner. */
    ownerToken: string;
}

/** Published with the game room's code when it disposes. */
export const standaloneClosedTopic = (partyCode: string): string => `party:${partyCode}:standaloneClosed`;

/** Read the creation options back; anything else (a room created straight from a client) has none. */
export const readStandaloneCreateOptions = (options: unknown): Partial<StandaloneCreateOptions> => {
    if (typeof options !== 'object' || options === null) return {};
    const { partyCode, ownerToken } = options as Record<string, unknown>;
    return {
        partyCode: typeof partyCode === 'string' && partyCode.length > 0 ? partyCode : undefined,
        ownerToken: typeof ownerToken === 'string' && ownerToken.length > 0 ? ownerToken : undefined
    };
};
