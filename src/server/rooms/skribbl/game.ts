/**
 * A game of Skribbl, from start to podium. Framework-free: it works on the
 * synced state through SkribblContext and keeps time with the Scheduler.
 *
 *   start -> round 1: each player's turn -> … -> round N -> podium -> lobby
 *   turn:    choosing (drawer picks a word) -> drawing (others guess) -> reveal
 *
 * The server is the authority (netcode guide, section 1): it picks the words,
 * keeps the word secret, judges every guess, runs every timer and scores.
 * Clients send only intent: which word, a chat line, and draw packets. The
 * drawer owns what is on the canvas; the server owns who may draw, and when.
 *
 * The word is never in synced state. It goes privately to the drawer, and to
 * each guesser once they guess it; everyone else sees its pattern, which
 * gains a letter at each hint.
 */

import { SKRIBBL_CHAT, SKRIBBL_TIMING, CANVAS } from '../../../shared/standalone/skribbl/constants.js';
import { CanvasModel, decodeDrawPacket, encodeDrawPacket } from '../../../shared/standalone/skribbl/canvas.js';
import { judgeGuess, revealsWord } from '../../../shared/standalone/skribbl/guess.js';
import { hintCount, hintTimesMs, pickHint, wordPattern } from '../../../shared/standalone/skribbl/hints.js';
import {
    SkribblBytes,
    SkribblMessage,
    type ChatPayload,
    type ChooseWordReply,
    type GameEndReason,
    type GameEndedPayload,
    type SayReply,
    type TurnEndReason,
    type TurnEndedPayload,
    type WordChoicesPayload,
    type WordPayload
} from '../../../shared/standalone/skribbl/protocol.js';
import { drawerPoints, guesserPoints } from '../../../shared/standalone/skribbl/scoring.js';
import { assignSharedRanks } from '../../../shared/games/ranking.js';
import type { LeaderboardRow, ScoreRow } from '../../../shared/protocol.js';
import type { Members } from '../../platform/members.js';
import { refuse, succeed, type Outcome } from '../../platform/outcome.js';
import { TimerSlot } from '../../platform/scheduler.js';
import { replaceArray } from '../../platform/schema/sync.js';
import { WordBank } from '../../standalone/skribbl/wordBank.js';
import type { SkribblLobby } from './lobby.js';
import type { SkribblContext } from './skribblContext.js';

/** The turn being played. Server-only: holds the secret word. */
interface Turn {
    id: number;
    drawerId: string;
    choices: string[];
    word: string | null;
    revealed: Set<number>;
    hintTimes: number[];
    drawStartedAtMs: number;
    drawMs: number;
    /** What each correct guesser scored, in guessing order. */
    scores: Map<string, number>;
}

export class SkribblGame {
    /** Drawers still to come this round, in order. */
    private queue: string[] = [];
    private turn: Turn | null = null;
    private readonly canvas = new CanvasModel();
    private lastTurnEnded: TurnEndedPayload | null = null;
    private lastGameEnded: GameEndedPayload | null = null;
    private readonly lastChatAt = new Map<string, number>();

    /** The current phase's deadline (choosing, drawing, reveal or podium). */
    private readonly phaseTimer: TimerSlot;
    private readonly hintTimer: TimerSlot;
    private readonly drawerGrace: TimerSlot;

    constructor(
        private readonly ctx: SkribblContext,
        private readonly members: Members,
        private readonly lobby: SkribblLobby,
        private readonly words: WordBank = new WordBank(undefined, ctx.randomInt)
    ) {
        this.phaseTimer = new TimerSlot(ctx.scheduler);
        this.hintTimer = new TimerSlot(ctx.scheduler);
        this.drawerGrace = new TimerSlot(ctx.scheduler);
    }

    private get state() {
        return this.ctx.state;
    }

    private get now(): number {
        return this.ctx.scheduler.now();
    }

    /* ------------------------------------------------------------------ */
    /* Owner actions                                                        */
    /* ------------------------------------------------------------------ */

    start(playerId: string): Outcome<null> {
        const allowed = this.lobby.checkStart(playerId);
        if (!allowed.ok) return allowed;
        for (const player of this.state.players.values()) player.points = 0;
        this.words.reset();
        this.lastTurnEnded = null;
        this.lastGameEnded = null;
        this.state.phase = 'playing';
        this.state.turn.round = 0;
        this.state.turn.totalRounds = this.lobby.settings.rounds;
        this.lobby.refresh();
        this.nextRound();
        return succeed(null);
    }

    /** Owner: stop the game wherever it is and go back to the lobby. */
    returnToLobby(playerId: string): Outcome<null> {
        if (!this.members.isOwner(playerId)) return refuse('not_owner', 'Only the room owner can do that.');
        if (this.state.phase === 'lobby') return refuse('wrong_phase', 'The room is already in the lobby.');
        this.backToLobby();
        return succeed(null);
    }

    /* ------------------------------------------------------------------ */
    /* Player actions                                                       */
    /* ------------------------------------------------------------------ */

    chooseWord(playerId: string, turnId: number, index: number): Outcome<ChooseWordReply> {
        const turn = this.turn;
        if (!turn || turnId !== turn.id) return refuse('stale_round', 'That turn is over.');
        if (playerId !== turn.drawerId) return refuse('not_drawer', 'Only the drawer picks the word.');
        if (this.state.turn.phase !== 'choosing') return refuse('wrong_phase', 'The word is already chosen.');
        const word = turn.choices[index];
        if (word === undefined) return refuse('invalid_payload', 'Pick one of the offered words.');
        this.startDrawing(word);
        return succeed({ word });
    }

    /**
     * A chat line. While someone draws, a guesser's line is a guess: a correct
     * one is never shown, only that they got it. The drawer and players who
     * already guessed talk in their own channel, and may not spell the word.
     */
    say(playerId: string, rawText: string): Outcome<SayReply> {
        if (!this.members.get(playerId)) return refuse('not_in_room', 'You are not in this room.');
        const text = rawText.replace(/\s+/g, ' ').trim().slice(0, SKRIBBL_CHAT.MAX_LENGTH);
        if (text.length === 0) return refuse('invalid_payload', 'Say something.');
        const last = this.lastChatAt.get(playerId);
        if (last !== undefined && this.now - last < SKRIBBL_CHAT.MIN_INTERVAL_MS) {
            return refuse('rate_limited', 'Slow down a little.');
        }
        this.lastChatAt.set(playerId, this.now);

        const turn = this.turn;
        const drawing = this.state.phase === 'playing' && this.state.turn.phase === 'drawing';
        const word = drawing ? turn?.word : null;
        if (!turn || !word) {
            this.chat({ kind: 'message', playerId, text, channel: 'all' });
            return succeed({ verdict: 'sent' });
        }

        if (this.knowsWord(playerId)) {
            if (revealsWord(text, word)) return refuse('reveals_word', "Don't give the word away.");
            this.chat({ kind: 'message', playerId, text, channel: 'guessed' });
            return succeed({ verdict: 'sent' });
        }

        const verdict = judgeGuess(text, word);
        if (verdict === 'correct') {
            this.registerGuess(turn, playerId);
            return succeed({ verdict: 'correct' });
        }
        // A wrong or close guess is shown like any chat line; only its author hears it was close.
        this.chat({ kind: 'message', playerId, text, channel: 'all' });
        return succeed({ verdict: verdict === 'close' ? 'close' : 'sent' });
    }

    /**
     * A draw packet from the drawer. Fire and forget: anything that isn't the
     * current drawer drawing the current turn, or doesn't parse, or would take
     * the turn past its limits, is dropped. Accepted packets are kept and the
     * same bytes go to everyone else.
     */
    draw(playerId: string, bytes: Uint8Array): void {
        const turn = this.turn;
        if (!turn || playerId !== turn.drawerId || this.state.turn.phase !== 'drawing') return;
        if (bytes.length > CANVAS.MAX_PACKET_BYTES) return;
        const packet = decodeDrawPacket(bytes);
        if (!packet || packet.turnId !== turn.id) return;
        if (!this.canvas.tryApply(packet.ops)) return;
        this.ctx.broadcastBytes(SkribblBytes.Draw, bytes, playerId);
    }

    /* ------------------------------------------------------------------ */
    /* Connections                                                          */
    /* ------------------------------------------------------------------ */

    /** A newcomer joins as a guesser straight away, and draws from the next round. */
    onPlayerJoined(playerId: string): void {
        this.catchUp(playerId);
    }

    /** The socket dropped. A drawer gets a short grace to come back before the turn is given up. */
    onPlayerDropped(playerId: string): void {
        if (this.isActiveDrawer(playerId)) {
            this.drawerGrace.set(SKRIBBL_TIMING.DRAWER_GRACE_MS, () => this.endTurn('drawer-left'));
            return;
        }
        this.endTurnIfAllGuessed();
    }

    onPlayerReconnected(playerId: string): void {
        if (this.isActiveDrawer(playerId)) this.drawerGrace.clear();
        this.catchUp(playerId);
    }

    /** Gone for good (left, kicked, or the reconnect grace ran out). */
    onPlayerLeft(playerId: string): void {
        this.lastChatAt.delete(playerId);
        this.queue = this.queue.filter((id) => id !== playerId);
        if (this.state.phase !== 'playing') return;
        if (this.state.players.size < this.state.minPlayers) {
            this.endGame('not_enough_players');
            return;
        }
        if (this.isActiveDrawer(playerId)) {
            this.endTurn('drawer-left');
            return;
        }
        this.endTurnIfAllGuessed();
    }

    dispose(): void {
        this.phaseTimer.clear();
        this.hintTimer.clear();
        this.drawerGrace.clear();
    }

    /* ------------------------------------------------------------------ */
    /* Turn flow                                                            */
    /* ------------------------------------------------------------------ */

    private nextRound(): void {
        this.state.turn.round += 1;
        this.queue = this.members.active().map((player) => player.id);
        this.nextTurn();
    }

    private nextTurn(): void {
        if (this.members.active().length < this.state.minPlayers) {
            this.endGame('not_enough_players');
            return;
        }
        // Skip anyone who left or is disconnected when their turn comes.
        let drawerId: string | undefined;
        while ((drawerId = this.queue.shift()) !== undefined) {
            if (this.members.get(drawerId)?.connected) break;
        }
        if (drawerId === undefined) {
            if (this.state.turn.round < this.state.turn.totalRounds) this.nextRound();
            else this.endGame('finished');
            return;
        }

        const turnId = this.state.turn.turnId + 1;
        const choices = this.words.choices(this.lobby.settings.wordChoices);
        this.turn = {
            id: turnId,
            drawerId,
            choices,
            word: null,
            revealed: new Set(),
            hintTimes: [],
            drawStartedAtMs: 0,
            drawMs: this.lobby.settings.drawTimeSec * 1000,
            scores: new Map()
        };
        this.canvas.clear();
        this.lastTurnEnded = null;

        const endsAtMs = this.now + SKRIBBL_TIMING.CHOOSE_MS;
        const turnState = this.state.turn;
        turnState.turnId = turnId;
        turnState.phase = 'choosing';
        turnState.drawerId = drawerId;
        turnState.endsAtMs = endsAtMs;
        turnState.drawTimeMs = this.turn.drawMs;
        turnState.wordPattern = '';
        replaceArray(turnState.guessed, []);

        this.sendChoices(drawerId);
        // Too slow to pick: one is picked for them.
        this.phaseTimer.set(SKRIBBL_TIMING.CHOOSE_MS, () => {
            const word = choices[this.ctx.randomInt(choices.length)]!;
            this.startDrawing(word);
        });
    }

    private startDrawing(word: string): void {
        const turn = this.turn;
        if (!turn) return;
        turn.word = word;
        turn.drawStartedAtMs = this.now;
        turn.hintTimes = hintTimesMs(hintCount(word, this.lobby.settings.hints), turn.drawMs);

        const turnState = this.state.turn;
        turnState.phase = 'drawing';
        turnState.endsAtMs = this.now + turn.drawMs;
        turnState.wordPattern = wordPattern(word);

        this.sendWord(turn.drawerId);
        this.scheduleNextHint();
        this.phaseTimer.set(turn.drawMs, () => this.endTurn('time'));
    }

    private scheduleNextHint(): void {
        const turn = this.turn;
        const dueAt = turn?.hintTimes[turn.revealed.size];
        if (!turn || dueAt === undefined) return;
        this.hintTimer.set(turn.drawStartedAtMs + dueAt - this.now, () => {
            if (!turn.word || this.turn !== turn) return;
            const index = pickHint(turn.word, turn.revealed, this.ctx.randomInt);
            if (index === null) return;
            turn.revealed.add(index);
            this.state.turn.wordPattern = wordPattern(turn.word, turn.revealed);
            this.scheduleNextHint();
        });
    }

    private registerGuess(turn: Turn, playerId: string): void {
        const remainingMs = this.state.turn.endsAtMs - this.now;
        const points = guesserPoints(remainingMs, turn.drawMs, turn.scores.size);
        turn.scores.set(playerId, points);
        const player = this.members.get(playerId);
        if (player) player.points += points;
        this.state.turn.guessed.push(playerId);
        this.sendWord(playerId);
        this.chat({ kind: 'guessed', playerId, points });
        this.endTurnIfAllGuessed();
    }

    /** Everyone who could guess has guessed: the turn is over. */
    private endTurnIfAllGuessed(): void {
        const turn = this.turn;
        if (!turn || this.state.phase !== 'playing' || this.state.turn.phase !== 'drawing') return;
        const guessers = this.guessers(turn);
        if (guessers.length > 0 && guessers.every((id) => turn.scores.has(id))) this.endTurn('all-guessed');
    }

    private endTurn(reason: TurnEndReason): void {
        const turn = this.turn;
        const phase = this.state.turn.phase;
        if (!turn || this.state.phase !== 'playing' || (phase !== 'choosing' && phase !== 'drawing')) return;
        this.hintTimer.clear();
        this.drawerGrace.clear();

        const guesserScores = [...turn.scores.values()];
        const eligible = new Set([...this.guessers(turn), ...turn.scores.keys()]).size;
        const drawerScore = reason === 'drawer-left' ? 0 : drawerPoints(guesserScores, eligible);
        const drawer = this.members.get(turn.drawerId);
        if (drawer) drawer.points += drawerScore;

        const points: ScoreRow[] = [...this.state.players.keys()]
            .map((playerId) => ({
                playerId,
                points: playerId === turn.drawerId ? drawerScore : turn.scores.get(playerId) ?? 0
            }))
            .sort((a, b) => b.points - a.points);

        const nextAtServerMs = this.now + SKRIBBL_TIMING.REVEAL_MS;
        const turnState = this.state.turn;
        turnState.phase = 'reveal';
        turnState.endsAtMs = nextAtServerMs;
        if (turn.word) turnState.wordPattern = turn.word;

        this.lastTurnEnded = { turnId: turn.id, word: turn.word, reason, points, nextAtServerMs };
        this.ctx.broadcast(SkribblMessage.TurnEnded, this.lastTurnEnded);
        this.phaseTimer.set(SKRIBBL_TIMING.REVEAL_MS, () => this.nextTurn());
    }

    private endGame(reason: GameEndReason): void {
        this.phaseTimer.clear();
        this.hintTimer.clear();
        this.drawerGrace.clear();
        this.turn = null;
        this.queue = [];

        const sorted = [...this.state.players.values()].sort(
            (a, b) => b.points - a.points || a.joinOrder - b.joinOrder
        );
        const ranked = assignSharedRanks(sorted, (a, b) => a.points === b.points);
        const rows: LeaderboardRow[] = ranked.map(({ item, rank }) => ({
            playerId: item.id,
            points: item.points,
            rank
        }));

        const lobbyAtServerMs = this.now + SKRIBBL_TIMING.PODIUM_MS;
        this.state.phase = 'podium';
        this.resetTurnState();
        this.lastGameEnded = { reason, rows, lobbyAtServerMs };
        this.ctx.broadcast(SkribblMessage.GameEnded, this.lastGameEnded);
        this.phaseTimer.set(SKRIBBL_TIMING.PODIUM_MS, () => this.backToLobby());
    }

    private backToLobby(): void {
        this.dispose();
        this.turn = null;
        this.queue = [];
        this.canvas.clear();
        this.lastTurnEnded = null;
        this.lastGameEnded = null;
        this.state.phase = 'lobby';
        this.resetTurnState();
        this.lobby.refresh();
    }

    private resetTurnState(): void {
        const turnState = this.state.turn;
        turnState.phase = 'idle';
        turnState.drawerId = '';
        turnState.endsAtMs = 0;
        turnState.wordPattern = '';
        replaceArray(turnState.guessed, []);
    }

    /* ------------------------------------------------------------------ */
    /* Helpers                                                              */
    /* ------------------------------------------------------------------ */

    /** Connected players other than the drawer: the ones who can guess right now. */
    private guessers(turn: Turn): string[] {
        return this.members
            .active()
            .map((player) => player.id)
            .filter((id) => id !== turn.drawerId);
    }

    private isActiveDrawer(playerId: string): boolean {
        const phase = this.state.turn.phase;
        return (
            this.state.phase === 'playing' &&
            this.turn?.drawerId === playerId &&
            (phase === 'choosing' || phase === 'drawing')
        );
    }

    /** The drawer, or a player who guessed this turn. */
    private knowsWord(playerId: string): boolean {
        return this.turn !== null && (playerId === this.turn.drawerId || this.turn.scores.has(playerId));
    }

    private chat(payload: ChatPayload): void {
        if (payload.kind === 'message' && payload.channel === 'guessed' && this.turn) {
            const turn = this.turn;
            for (const id of [turn.drawerId, ...turn.scores.keys()]) {
                this.ctx.sendTo(id, SkribblMessage.Chat, payload);
            }
            return;
        }
        this.ctx.broadcast(SkribblMessage.Chat, payload);
    }

    private sendChoices(playerId: string): void {
        const turn = this.turn;
        if (!turn) return;
        const payload: WordChoicesPayload = {
            turnId: turn.id,
            words: [...turn.choices],
            endsAtServerMs: this.state.turn.endsAtMs
        };
        this.ctx.sendTo(playerId, SkribblMessage.WordChoices, payload);
    }

    private sendWord(playerId: string): void {
        const turn = this.turn;
        if (!turn?.word) return;
        const payload: WordPayload = { turnId: turn.id, word: turn.word };
        this.ctx.sendTo(playerId, SkribblMessage.Word, payload);
    }

    /**
     * Everything a player who just joined or reconnected needs beyond the
     * synced state: the drawing so far, and whatever private or one-off
     * message they would otherwise have missed.
     */
    private catchUp(playerId: string): void {
        if (this.state.phase === 'podium' && this.lastGameEnded) {
            this.ctx.sendTo(playerId, SkribblMessage.GameEnded, this.lastGameEnded);
            return;
        }
        const turn = this.turn;
        if (this.state.phase !== 'playing' || !turn) return;
        const phase = this.state.turn.phase;
        if (phase === 'choosing' && playerId === turn.drawerId) this.sendChoices(playerId);
        if ((phase === 'drawing' || phase === 'reveal') && !this.canvas.isEmpty) {
            const snapshot = encodeDrawPacket({ turnId: turn.id, ops: this.canvas.toOps() });
            this.ctx.sendBytesTo(playerId, SkribblBytes.Canvas, snapshot);
        }
        if (phase === 'drawing' && this.knowsWord(playerId)) this.sendWord(playerId);
        if (phase === 'reveal' && this.lastTurnEnded) {
            this.ctx.sendTo(playerId, SkribblMessage.TurnEnded, this.lastTurnEnded);
        }
    }
}
