/**
 * The match: Lobby -> for each game: [round -> results] x roundsPerGame ->
 * leaderboard -> Lobby.
 *
 * It owns the Competition (score table, playlist position) and the round
 * being played, and translates between the round runner and the room:
 * lifecycle and progress go into schema state, round data and results go out
 * as reliable messages.
 */

import { COMPETITION } from '../../../shared/constants.js';
import { GAME_CATALOG, type GameId } from '../../../shared/games/catalog.js';
import {
    ServerMessage,
    type GameStartingPayload,
    type RoundResultsPayload
} from '../../../shared/protocol.js';
import { Competition } from '../../competition/competition.js';
import { getSelfTimedModule } from '../../games/registry.js';
import { done, refuse, type Outcome } from '../../platform/outcome.js';
import { TimerSlot } from '../../platform/scheduler.js';
import type { AttemptResolved } from '../../rounds/roundTypes.js';
import { SelfTimedRound } from '../../rounds/selfTimedRound.js';
import type { Lobby } from './lobby.js';
import type { Members } from '../../platform/members.js';
import type { PartyContext } from './partyContext.js';
import {
    clearProgress,
    clearShared,
    resetRound,
    writeProgress,
    writeRoundDescription,
    writeRoundPosition,
    writeShared
} from './roundSync.js';
import { replaceArray } from '../../platform/schema/sync.js';

export class MatchFlow {
    private competition: Competition | null = null;
    private round: SelfTimedRound | null = null;
    /** Room-wide, so a late message from a previous match can never match a new round. */
    private roundCounter = 0;
    /** Earliest room time the owner may skip the results screen. */
    private skipAllowedAtMs = 0;
    private readonly betweenRounds: TimerSlot;

    constructor(
        private readonly ctx: PartyContext,
        private readonly members: Members,
        private readonly lobby: Lobby
    ) {
        this.betweenRounds = new TimerSlot(ctx.scheduler);
    }

    /* ------------------------------ owner actions ---------------------------- */

    start(playerId: string): Outcome<{ playlist: GameId[] }> {
        const prepared = this.lobby.preparePlaylist(playerId);
        if (!prepared.ok) return prepared;

        const playlist = prepared.value;
        const players = this.members.active().map((player) => player.id);
        this.competition = new Competition(playlist, players);
        this.ctx.state.phase = 'competition';
        replaceArray(this.ctx.state.playlist, playlist);
        this.ctx.state.totalRounds = this.competition.totalRounds;
        this.members.applyPoints((id) => this.competition?.pointsOf(id) ?? 0);
        this.lobby.refresh();
        this.startNextRound();
        return { ok: true, value: { playlist: [...playlist] } };
    }

    /** Owner's "skip the results screen" (or the leaderboard) button. */
    skipResults(playerId: string): Outcome {
        if (!this.members.isOwner(playerId)) return refuse('not_owner', 'Only the room owner can skip.');
        if (this.ctx.state.phase === 'leaderboard') {
            this.returnToLobby();
            return done;
        }
        if (this.ctx.state.phase !== 'competition' || !this.betweenRounds.isPending) {
            return refuse('wrong_phase', 'Nothing to skip right now.');
        }
        // Don't let a skip cut the ending animation short.
        if (this.ctx.scheduler.now() < this.skipAllowedAtMs) {
            return refuse('wrong_phase', 'Wait for the animation to finish.');
        }
        this.advanceRound();
        return done;
    }

    /**
     * Owner's "next game" button: abandon whatever the current game is doing
     * (mid-round included; the unfinished round awards nothing) and start the
     * next game, or the final leaderboard if this was the last one.
     */
    skipGame(playerId: string): Outcome {
        if (!this.members.isOwner(playerId)) return refuse('not_owner', 'Only the room owner can skip.');
        if (this.ctx.state.phase !== 'competition' || this.competition === null) {
            return refuse('wrong_phase', 'No game is being played.');
        }
        this.betweenRounds.clear();
        this.endRound();
        if (this.competition.skipGame()) this.startNextRound();
        else this.finishCompetition();
        return done;
    }

    /** Owner's "back to lobby" button: end the competition now, from any screen. */
    backToLobby(playerId: string): Outcome {
        if (!this.members.isOwner(playerId)) {
            return refuse('not_owner', 'Only the room owner can end the competition.');
        }
        if (this.ctx.state.phase === 'lobby') return refuse('wrong_phase', 'Already in the lobby.');
        this.returnToLobby();
        return done;
    }

    /* ----------------------- round actions, by roundId ----------------------- */

    markReady(playerId: string, roundId: number, attempt: number, ready = true): Outcome {
        return this.withRound(roundId, (round) => round.markReady(playerId, attempt, ready));
    }

    submitResult(playerId: string, roundId: number, attempt: number, result: unknown): Outcome {
        return this.withRound(roundId, (round) => round.submitResult(playerId, attempt, result));
    }

    handleAction(playerId: string, roundId: number, attempt: number, action: unknown): Outcome<unknown> {
        return this.withRound(roundId, (round) => round.handleAction(playerId, attempt, action));
    }

    submitProgress(playerId: string, roundId: number, attempt: number, progress: unknown): void {
        if (this.round?.roundId === roundId) this.round.submitProgress(playerId, attempt, progress);
    }

    /* --------------------------- membership changes -------------------------- */

    /** A new player: on the score table, and shown what everyone is playing. */
    onPlayerJoined(playerId: string): void {
        this.competition?.ensurePlayer(playerId);
        this.sendCurrentRoundData(playerId);
    }

    /** A drop or a leave: the round stops waiting on them straight away. */
    onPlayerGone(playerId: string): void {
        this.round?.dropParticipant(playerId);
    }

    /** Back within the grace period: into the running attempt, and resynced. */
    onPlayerReconnected(playerId: string): void {
        this.round?.rejoinParticipant(playerId);
        this.sendCurrentRoundData(playerId);
    }

    dispose(): void {
        this.betweenRounds.clear();
        this.round?.cancel();
        this.round = null;
    }

    /* -------------------------------- rounds -------------------------------- */

    private startNextRound(): void {
        const position = this.competition?.position() ?? null;
        if (this.competition === null || position === null) {
            this.finishCompetition();
            return;
        }
        const module = getSelfTimedModule(position.gameId);
        const participants = this.members.active().map((player) => player.id);
        if (module === null || participants.length === 0) {
            // Playlists only hold playable games, so this means everyone left:
            // tear the competition down rather than stall.
            this.returnToLobby();
            return;
        }

        const roundId = ++this.roundCounter;
        const starting: GameStartingPayload = {
            roundId,
            attempt: 0,
            gameId: position.gameId,
            title: GAME_CATALOG[position.gameId].title,
            gameIndex: position.gameIndex,
            totalGames: position.totalGames,
            roundInGame: position.roundInGame,
            roundsPerGame: position.roundsPerGame
        };
        this.ctx.broadcast(ServerMessage.GameStarting, starting);
        writeRoundPosition(this.ctx.state.round, position);

        const round: SelfTimedRound = new SelfTimedRound(
            {
                module,
                gameId: position.gameId,
                roundId,
                roundInGame: position.roundInGame,
                roundsPerGame: position.roundsPerGame,
                events: {
                    onRoundData: (payload) => {
                        clearProgress(this.ctx.state.round);
                        // A new round is a new runner, which knows nothing of the last round's world.
                        clearShared(this.ctx.state.round);
                        this.ctx.broadcast(ServerMessage.RoundData, payload);
                    },
                    onLifecycleChanged: () => writeRoundDescription(this.ctx.state.round, round.describe()),
                    onProgress: (playerId, progress) =>
                        writeProgress(this.ctx.state.round, playerId, progress),
                    onSharedChanged: (values) => writeShared(this.ctx.state.round, values),
                    onRoundClosing: (payload) => this.ctx.broadcast(ServerMessage.RoundClosing, payload),
                    onAttemptResolved: (resolved) => this.onAttemptResolved(round, resolved)
                }
            },
            this.ctx.scheduler
        );
        this.round = round;
        round.begin(participants);
    }

    private onAttemptResolved(round: SelfTimedRound, resolved: AttemptResolved): void {
        const competition = this.competition;
        if (competition === null || this.round !== round) return;

        if (resolved.isFinal) {
            competition.award(resolved.winnerId);
            this.members.applyPoints((id) => competition.pointsOf(id));
        }

        // Only a real ending has an ending animation; the results screen's own
        // display time starts once it is done.
        const finishAnimationMs = resolved.isFinal ? round.finishAnimationMs : 0;
        const resultsDelayMs = finishAnimationMs + COMPETITION.RESULT_DISPLAY_MS;
        const now = this.ctx.scheduler.now();

        const results: RoundResultsPayload = {
            roundId: resolved.roundId,
            attempt: resolved.attempt,
            gameId: round.gameId,
            ranked: resolved.ranked,
            noShow: resolved.noShow,
            winnerId: resolved.winnerId,
            decidedByCoinFlip: resolved.decidedByCoinFlip,
            isFinal: resolved.isFinal,
            scores: competition.scoreRows(),
            advancing: resolved.advancing,
            stageBreakMs: resolved.stageBreakMs,
            finishAnimationMs,
            nextRoundAtServerMs: resolved.isFinal ? now + resultsDelayMs : null
        };
        this.ctx.broadcast(ServerMessage.RoundResults, results);

        if (!resolved.isFinal) return;
        this.skipAllowedAtMs = now + finishAnimationMs;
        this.betweenRounds.set(resultsDelayMs, () => this.advanceRound());
    }

    private advanceRound(): void {
        this.betweenRounds.clear();
        this.endRound();
        if (this.competition?.advance()) this.startNextRound();
        else this.finishCompetition();
    }

    private finishCompetition(): void {
        if (this.competition === null) return;
        this.endRound();
        this.ctx.state.phase = 'leaderboard';
        this.ctx.broadcast(ServerMessage.Leaderboard, this.competition.leaderboard());
        this.betweenRounds.set(COMPETITION.LEADERBOARD_DISPLAY_MS, () => this.returnToLobby());
    }

    private returnToLobby(): void {
        this.betweenRounds.clear();
        this.endRound();
        this.competition = null;
        this.ctx.state.phase = 'lobby';
        replaceArray(this.ctx.state.playlist, []);
        this.ctx.state.totalRounds = 0;
        resetRound(this.ctx.state.round);
        this.members.resetForLobby();
        this.members.applyPoints(() => 0);
        this.lobby.refresh();
    }

    private endRound(): void {
        this.round?.cancel();
        this.round = null;
    }

    /* -------------------------------- helpers ------------------------------- */

    /** A message tagged with an old roundId is refused, not allowed to confuse this one. */
    private withRound<T>(roundId: number, action: (round: SelfTimedRound) => Outcome<T>): Outcome<T> {
        if (this.round === null) return refuse('wrong_phase', 'No round is running.');
        if (this.round.roundId !== roundId) return refuse('stale_round', 'That round has already finished.');
        return action(this.round);
    }

    /** Round data is a one-off message, so a (re)joining client needs it resent. */
    private sendCurrentRoundData(playerId: string): void {
        const payload = this.round?.roundDataPayload() ?? null;
        if (payload !== null) this.ctx.sendTo(playerId, ServerMessage.RoundData, payload);
    }
}
