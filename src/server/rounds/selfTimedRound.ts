/**
 * The self-timed round runner, shared by every built game.
 *
 * The server hands out the round data, waits for everyone to be ready, picks
 * a start a few seconds out, and collects what comes back:
 *
 *   loading -> ready-check -> starting -> countdown -> playing -> results
 *
 * It never measures anything itself, so latency cannot reach the outcome.
 * Stages and tiebreakers are further attempts inside one scoring round, which
 * still hands back exactly one winner.
 *
 * Framework-free: it talks to the room through `SelfTimedRoundEvents` and
 * keeps time through a `Scheduler`.
 */

import { SELF_TIMED } from '../../shared/constants.js';
import type { AttemptTiming, SharedWorld, SharedWorldView } from '../../shared/games/selfTimed.js';
import type { RoundDataPayload, RoundPhase } from '../../shared/protocol.js';
import type { AnySelfTimedModule } from '../games/registry.js';
import { done, refuse, succeed, type Outcome } from '../platform/outcome.js';
import { TimerSlot, type Scheduler } from '../platform/scheduler.js';
import { decideAttemptOutcome, describeOutcome } from './attemptOutcome.js';
import { AttemptRoster } from './attemptRoster.js';
import { EarlyClosing } from './earlyClosing.js';
import { ProgressRelay } from './progressRelay.js';
import type {
    RoundDescription,
    SelfTimedRoundEvents,
    SelfTimedRoundOptions
} from './roundTypes.js';

const DEFAULT_TIMING: AttemptTiming = {
    startLeadMs: SELF_TIMED.START_LEAD_MS,
    countdownMs: SELF_TIMED.COUNTDOWN_MS
};

/** Phases in which a dropped player may come back into the attempt. */
const REJOINABLE_PHASES: readonly RoundPhase[] = ['ready-check', 'starting', 'countdown', 'playing'];

export class SelfTimedRound {
    private phase: RoundPhase = 'idle';
    private attempt = 0;
    private isTiebreak = false;
    private tiebreakersRun = 0;
    private timing: AttemptTiming = DEFAULT_TIMING;
    private roundData: unknown = null;
    private startAtMs: number | null = null;
    private readyDeadlineMs = 0;
    private cancelled = false;
    /** The attempt's shared world (see SharedWorld): server-owned values every player sees. */
    private readonly shared = new Map<string, number>();

    private readonly roster = new AttemptRoster();
    private readonly phaseTimer: TimerSlot;
    private readonly closing: EarlyClosing;
    private readonly progress: ProgressRelay;

    constructor(
        private readonly options: SelfTimedRoundOptions,
        private readonly scheduler: Scheduler
    ) {
        this.phaseTimer = new TimerSlot(scheduler);
        this.closing = new EarlyClosing(
            scheduler,
            (pending, graceMs) =>
                this.events.onRoundClosing({ roundId: this.roundId, attempt: this.attempt, pending, graceMs }),
            () => {
                if (this.phase === 'playing') this.resolve();
            }
        );
        const { progressHz } = options.module;
        this.progress = new ProgressRelay(
            scheduler,
            (playerId, progress) => this.events.onProgress(playerId, progress),
            (playerId) => this.phase === 'playing' && this.roster.has(playerId),
            // A little under the game's own interval, so the client's timer jitter isn't punished.
            progressHz === undefined ? undefined : Math.floor((1000 / progressHz) * 0.8)
        );
    }

    get roundId(): number {
        return this.options.roundId;
    }

    get gameId(): SelfTimedRoundOptions['gameId'] {
        return this.options.gameId;
    }

    private get module(): AnySelfTimedModule {
        return this.options.module;
    }

    private get events(): SelfTimedRoundEvents {
        return this.options.events;
    }

    /** Time clients need to play this game's ending animation. Zero if it has none. */
    get finishAnimationMs(): number {
        return this.module.finishAnimationMs ?? 0;
    }

    begin(participants: readonly string[]): void {
        this.startAttempt(0, false, participants);
    }

    /** Stop everything. Used when the room is disposed or the match aborted. */
    cancel(): void {
        this.cancelled = true;
        this.phaseTimer.clear();
        this.closing.reset();
        this.progress.dropHeld();
        this.phase = 'idle';
    }

    /* ---------------------------- client actions ---------------------------- */

    /**
     * Ready, or (`ready` false) taking it back. A player can change their mind
     * until the lead before the start runs out: taking it back while the start
     * is scheduled calls the start off, and the ready check runs again.
     */
    markReady(playerId: string, attempt: number, ready = true): Outcome {
        if (!ready) return this.markUnready(playerId, attempt);
        const refused = this.guard(playerId, attempt, 'ready-check');
        if (refused) return refused;
        if (!this.roster.markReady(playerId)) return done;

        this.events.onLifecycleChanged();
        if (this.roster.allReady()) this.scheduleStart();
        return done;
    }

    private markUnready(playerId: string, attempt: number): Outcome {
        const refused =
            this.phase === 'starting' ? this.guard(playerId, attempt, 'starting') : this.guard(playerId, attempt, 'ready-check');
        if (refused) return refused;
        if (!this.roster.markUnready(playerId)) return done;

        if (this.phase === 'starting') {
            // The start is off. Whoever backed out gets a moment to come back before the ready check gives up on them.
            this.phase = 'ready-check';
            this.startAtMs = null;
            this.readyDeadlineMs = Math.max(this.readyDeadlineMs, this.scheduler.now() + SELF_TIMED.UNREADY_GRACE_MS);
            this.phaseTimer.set(this.readyDeadlineMs - this.scheduler.now(), () => this.onReadyCheckTimeout());
        }
        this.events.onLifecycleChanged();
        return done;
    }

    submitResult(playerId: string, attempt: number, raw: unknown): Outcome {
        const refused = this.guard(playerId, attempt, 'playing');
        if (refused) return refused;
        // Keep the first report per player per attempt, ignore repeats.
        if (this.roster.hasResult(playerId)) return refuse('duplicate_result', 'Already reported.');

        const parsed = this.module.parseResult(raw, this.roundData);
        if (parsed === null) return refuse('invalid_payload', 'Malformed result.');

        this.roster.recordResult(playerId, parsed);
        const announced = this.module.progressFromResult?.(parsed, this.roundData, playerId) ?? null;
        if (announced !== null) this.progress.sendNow(playerId, announced);
        this.afterParticipationChanged();
        return done;
    }

    /** A mid-round request the game answers itself (e.g. casting the dice). */
    handleAction(playerId: string, attempt: number, raw: unknown): Outcome<unknown> {
        const refused = this.guard(playerId, attempt, 'playing');
        if (refused) return refused;
        if (this.module.handleAction === undefined) {
            return refuse('invalid_payload', 'This game has no actions.');
        }
        const reply = this.module.handleAction(this.roundData, playerId, raw, this.sharedWorld());
        if (reply === null) return refuse('invalid_payload', 'Malformed action.');
        // An action can decide the round (Mage Battle's last knock-out).
        this.closeEarlyIfDecided();
        return succeed(reply);
    }

    /** Display-only, rate limited, and never allowed to affect the outcome. */
    submitProgress(playerId: string, attempt: number, raw: unknown): void {
        if (this.guard(playerId, attempt, 'playing')) return;
        const parsed = this.module.parseProgress(raw, this.roundData);
        if (parsed !== null) this.progress.submit(playerId, parsed);
    }

    /* ------------------------------ membership ------------------------------ */

    /** A dropped player reconnected while their attempt is still running. */
    rejoinParticipant(playerId: string): boolean {
        if (!REJOINABLE_PHASES.includes(this.phase) || !this.roster.rejoin(playerId)) return false;
        this.events.onLifecycleChanged();
        return true;
    }

    /** They stop being waited on, but a result they already submitted still counts. */
    dropParticipant(playerId: string): void {
        if (!this.roster.drop(playerId)) return;
        this.progress.dropHeld(playerId);
        this.events.onLifecycleChanged();

        if (this.phase === 'ready-check') {
            if (this.roster.size === 0) this.resolve();
            else if (this.roster.allReady()) this.scheduleStart();
        } else if (this.phase === 'playing') {
            this.afterParticipationChanged();
        }
    }

    /* -------------------------------- views --------------------------------- */

    describe(): RoundDescription {
        return {
            phase: this.phase,
            roundId: this.roundId,
            attempt: this.attempt,
            gameId: this.gameId,
            isTiebreak: this.isTiebreak,
            participants: this.roster.list(),
            ready: this.roster.readyList(),
            waitingFor: this.roster.waitingFor(),
            readyDeadlineMs: this.phase === 'ready-check' ? this.readyDeadlineMs : 0,
            startAtMs: this.startAtMs,
            countdownMs: this.timing.countdownMs,
            timingStartsAtMs:
                this.startAtMs === null ? null : this.startAtMs + this.timing.countdownMs,
            resultTimeoutMs:
                this.roundData === null ? 0 : this.module.resultTimeoutMs(this.roundData)
        };
    }

    /** The current attempt's public data, also used for a client that (re)joins mid-round. */
    roundDataPayload(): RoundDataPayload | null {
        if (this.roundData === null) return null;
        return {
            roundId: this.roundId,
            attempt: this.attempt,
            gameId: this.gameId,
            data: this.roundData,
            isTiebreak: this.isTiebreak,
            participants: this.roster.list(),
            resultTimeoutMs: this.module.resultTimeoutMs(this.roundData)
        };
    }

    /** The shared world, read-only, as ranking and the early-close check see it. */
    private sharedView(): SharedWorldView {
        return { get: (key) => this.shared.get(key) };
    }

    /** The shared world as a game's action sees it, timed from this attempt's start. */
    private sharedWorld(): SharedWorld {
        const startsAtMs = (this.startAtMs ?? this.scheduler.now()) + this.timing.countdownMs;
        return {
            raceMs: this.scheduler.now() - startsAtMs,
            get: (key) => this.shared.get(key),
            set: (key, value) => {
                if (this.shared.get(key) === value) return;
                this.shared.set(key, value);
                this.events.onSharedChanged(Object.fromEntries(this.shared));
            }
        };
    }

    /* ------------------------------- lifecycle ------------------------------ */

    private startAttempt(
        attempt: number,
        isTiebreak: boolean,
        participants: readonly string[],
        timingOverride?: AttemptTiming
    ): void {
        if (this.cancelled) return;

        this.attempt = attempt;
        this.isTiebreak = isTiebreak;
        this.roster.reset(participants);
        this.roundData = this.module.createRoundData({
            roundInGame: this.options.roundInGame,
            roundsPerGame: this.options.roundsPerGame,
            playerIds: this.roster.list(),
            attempt
        });
        this.timing =
            timingOverride ??
            (attempt === 0 ? this.module.openingTiming?.(this.roundData) : null) ??
            DEFAULT_TIMING;
        this.progress.reset();
        this.closing.reset();
        this.startAtMs = null;
        if (this.shared.size > 0) {
            this.shared.clear();
            this.events.onSharedChanged({});
        }

        // Loading: the round data goes out and clients build what they need.
        this.phase = 'loading';
        this.events.onRoundData(this.roundDataPayload()!);

        // Ready check: nothing is scheduled until everyone has acknowledged.
        this.phase = 'ready-check';
        this.readyDeadlineMs = this.scheduler.now() + SELF_TIMED.READY_CHECK_TIMEOUT_MS;
        this.phaseTimer.set(SELF_TIMED.READY_CHECK_TIMEOUT_MS, () => this.onReadyCheckTimeout());
        this.events.onLifecycleChanged();

        // An empty attempt (everyone left) resolves rather than hanging.
        if (this.roster.size === 0) this.resolve();
    }

    /** Someone never acknowledged: start without them rather than hang the room. */
    private onReadyCheckTimeout(): void {
        if (this.phase !== 'ready-check') return;
        this.roster.removeUnready();
        if (this.roster.size === 0) this.resolve();
        else this.scheduleStart();
    }

    private scheduleStart(): void {
        this.phase = 'starting';
        this.startAtMs = this.scheduler.now() + this.timing.startLeadMs;
        this.phaseTimer.set(this.timing.startLeadMs, () => this.beginCountdown());
        this.events.onLifecycleChanged();
    }

    /** Clients show "3, 2, 1". Nothing is timed yet, so no deadline is running. */
    private beginCountdown(): void {
        if (this.phase !== 'starting') return;
        this.phase = 'countdown';
        this.phaseTimer.set(this.timing.countdownMs, () => this.beginPlaying());
        this.events.onLifecycleChanged();
    }

    /** The game's timeout is measured from when timing starts, as its name says. */
    private beginPlaying(): void {
        if (this.phase !== 'countdown') return;
        this.phase = 'playing';
        this.phaseTimer.set(this.module.resultTimeoutMs(this.roundData), () => this.resolve());
        this.events.onLifecycleChanged();
    }

    /** After a result or a drop: resolve once nobody is pending, else maybe close early. */
    private afterParticipationChanged(): void {
        if (this.roster.pending().length === 0) this.resolve();
        else this.closeEarlyIfDecided();
    }

    /** For games that end early: once the game says the round is decided, close it. */
    private closeEarlyIfDecided(): void {
        if (this.closing.hasClosed || this.phase !== 'playing' || !this.module.shouldCloseEarly) return;
        const reported = this.roster.participantResults();
        if (this.module.shouldCloseEarly(reported, this.roster.size, this.roundData, this.sharedView())) {
            this.closing.close(this.roster.pending());
        }
    }

    private resolve(): void {
        if (this.cancelled || this.phase === 'results' || this.roundData === null) return;
        this.phaseTimer.clear();
        this.closing.reset();
        this.progress.dropHeld();
        this.phase = 'results';
        this.events.onLifecycleChanged();

        const ranked = this.module.rank(this.roster.resultEntries(), this.roundData, this.sharedView());
        const noShow = this.roster.pending();
        const stage = this.module.nextStage?.(ranked, this.roundData) ?? null;
        const outcome = decideAttemptOutcome(ranked, stage, this.tiebreakersRun);

        this.events.onAttemptResolved({
            roundId: this.roundId,
            attempt: this.attempt,
            isTiebreak: this.isTiebreak,
            ranked,
            noShow,
            ...describeOutcome(outcome)
        });

        if (outcome.kind === 'next-stage') {
            const { participants, pauseMs, timing } = outcome.stage;
            this.queueAttempt(pauseMs, false, participants, timing);
        } else if (outcome.kind === 'tiebreak') {
            this.tiebreakersRun += 1;
            this.queueAttempt(SELF_TIMED.TIEBREAK_DELAY_MS, true, outcome.tied);
        }
    }

    private queueAttempt(
        delayMs: number,
        isTiebreak: boolean,
        participants: readonly string[],
        timing?: AttemptTiming
    ): void {
        const nextAttempt = this.attempt + 1;
        this.phaseTimer.set(delayMs, () =>
            this.startAttempt(nextAttempt, isTiebreak, participants, timing)
        );
    }

    /** The checks every client action shares. Returns a refusal, or null to proceed. */
    private guard(playerId: string, attempt: number, phase: RoundPhase): Outcome<never> | null {
        if (attempt !== this.attempt) return refuse('stale_round', 'That attempt is over.');
        if (this.phase !== phase) return refuse('wrong_phase', `The round is not in ${phase}.`);
        if (!this.roster.has(playerId)) return refuse('not_in_room', 'Not playing this round.');
        return null;
    }
}
