/**
 * The competition: Lobby -> for each game: [each of its rounds -> results]
 * -> final leaderboard -> Lobby.
 *
 * It owns the position within the playlist and the score table. Games report
 * a winner and never touch the leaderboard themselves.
 */

import type { GameId } from '../../shared/games/catalog.js';
import type { LeaderboardPayload, LeaderboardRow, ScoreRow } from '../../shared/protocol.js';
import { roundsForGame } from '../games/registry.js';

export interface RoundPosition {
    gameId: GameId;
    /** 1-based position in the playlist. */
    gameIndex: number;
    totalGames: number;
    /** 1-based round within the game. */
    roundInGame: number;
    /** How many scoring rounds this game has in total. */
    roundsPerGame: number;
}

export class Competition {
    readonly playlist: readonly GameId[];

    private gameCursor = 0;
    private roundCursor = 0;
    private readonly scores = new Map<string, number>();

    constructor(playlist: readonly GameId[], players: readonly string[]) {
        this.playlist = playlist;
        for (const playerId of players) this.scores.set(playerId, 0);
    }

    get totalRounds(): number {
        return this.playlist.reduce((sum, gameId) => sum + roundsForGame(gameId), 0);
    }

    /** Players who join mid-competition watch, but exist on the score table at 0. */
    ensurePlayer(playerId: string): void {
        if (!this.scores.has(playerId)) this.scores.set(playerId, 0);
    }

    pointsOf(playerId: string): number {
        return this.scores.get(playerId) ?? 0;
    }

    /** Where we are now, or null once the playlist is exhausted. */
    position(): RoundPosition | null {
        const gameId = this.playlist[this.gameCursor];
        if (gameId === undefined) return null;
        return {
            gameId,
            gameIndex: this.gameCursor + 1,
            totalGames: this.playlist.length,
            roundInGame: this.roundCursor + 1,
            roundsPerGame: roundsForGame(gameId)
        };
    }

    /** Move past the round just finished. Returns false when the match is over. */
    advance(): boolean {
        this.roundCursor += 1;
        const currentGame = this.playlist[this.gameCursor];
        if (currentGame === undefined || this.roundCursor >= roundsForGame(currentGame)) {
            this.roundCursor = 0;
            this.gameCursor += 1;
        }
        return this.gameCursor < this.playlist.length;
    }

    /** Abandon the rest of the current game. Returns false when it was the last one. */
    skipGame(): boolean {
        this.roundCursor = 0;
        this.gameCursor = Math.min(this.gameCursor + 1, this.playlist.length);
        return this.gameCursor < this.playlist.length;
    }

    /** One point per scoring round. A round with no winner awards nothing. */
    award(winnerId: string | null): void {
        if (winnerId === null) return;
        this.scores.set(winnerId, this.pointsOf(winnerId) + 1);
    }

    scoreRows(): ScoreRow[] {
        return [...this.scores]
            .map(([playerId, points]) => ({ playerId, points }))
            .sort((a, b) => b.points - a.points || a.playerId.localeCompare(b.playerId));
    }

    /** Tied final scores are left tied: there is no overall tiebreaker. */
    leaderboard(): LeaderboardPayload {
        const rows: LeaderboardRow[] = [];
        this.scoreRows().forEach((row, index) => {
            const previous = rows[index - 1];
            const rank = previous?.points === row.points ? previous.rank : index + 1;
            rows.push({ ...row, rank });
        });
        return { rows, tied: rows.filter((row) => row.rank === 1).length > 1 };
    }
}
