/**
 * A whole competition through the room's controllers: lobby rules, rounds,
 * points, results screens, the leaderboard and back to the lobby.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COMPETITION } from '../src/shared/constants.js';
import { MAGE_BATTLE } from '../src/shared/games/mageBattle/constants.js';
import { STOP_THE_CLOCK, type StopTheClockRound } from '../src/shared/games/stopTheClock.js';
import {
    ServerMessage,
    type LeaderboardPayload,
    type RoundDataPayload,
    type RoundResultsPayload
} from '../src/shared/protocol.js';
import { createPartyHarness } from './support/partyHarness.js';

type Party = ReturnType<typeof createPartyHarness>;

/**
 * Play one Stop the Clock target: `winner` is exact and everyone else is off
 * by `othersOffMs` (by default way off, stopping at zero).
 */
const playStopTheClockTarget = (party: Party, winner: string, othersOffMs?: number) => {
    party.playToTiming();
    const { roundId, attempt, participants } = party.state.round;
    const data = party.messages<RoundDataPayload<StopTheClockRound>>(ServerMessage.RoundData).at(-1)!;
    for (const id of participants) {
        const elapsedMs = id === winner ? data.data.targetMs : othersOffMs === undefined ? 0 : data.data.targetMs + othersOffMs;
        party.match.submitResult(id, roundId, attempt, { elapsedMs, timingSuspect: false });
    }
};

/** A whole Stop the Clock round: one target per entry, with the scores break between them. */
const playStopTheClockGame = (party: Party, targets: readonly (readonly [winner: string, othersOffMs?: number])[]) => {
    targets.forEach(([winner, othersOffMs], index) => {
        playStopTheClockTarget(party, winner, othersOffMs);
        if (index < targets.length - 1) party.clock.advance(STOP_THE_CLOCK.SCORES_BREAK_MS);
    });
};

const startStopTheClock = (players = ['host', 'guest'], playlist = ['stop-the-clock']) => {
    const party = createPartyHarness(players);
    party.lobby.setMode('host', 'custom', playlist as Parameters<typeof party.lobby.setMode>[2]);
    party.readyUp();
    assert.equal(party.match.start('host').ok, true);
    return party;
};

describe('lobby rules', () => {
    it('the creator owns the room, and start waits for enough ready players', () => {
        const party = createPartyHarness(['host']);
        assert.equal(party.state.ownerId, 'host');
        assert.equal(party.state.lobby.blockedReason, 'not_enough_players');

        party.join('guest');
        assert.equal(party.state.lobby.blockedReason, 'players_not_ready');
        const refused = party.match.start('host');
        assert.equal(!refused.ok && refused.error.code, 'players_not_ready');

        party.lobby.setReady('guest', true);
        assert.equal(party.state.lobby.canStart, true);
        const notOwner = party.match.start('guest');
        assert.equal(!notOwner.ok && notOwner.error.code, 'not_owner');
    });

    it('a player holding a disconnected slot does not block the start', () => {
        const party = createPartyHarness(['host', 'guest', 'gone']);
        party.lobby.setReady('guest', true);
        party.members.markDisconnected('gone');
        party.lobby.refresh();
        assert.equal(party.state.lobby.canStart, true);
    });

    it('latecomers watch until the competition ends', () => {
        const party = startStopTheClock();
        party.join('late');
        assert.equal(party.state.players.get('late')?.isSpectator, true);
        assert.ok(!party.state.round.participants.includes('late'));
        const roundData = party.sent.filter((m) => m.type === ServerMessage.RoundData);
        assert.deepEqual(roundData.map((m) => m.to), ['all', 'late'], 'resent to the latecomer');
    });
});

describe('competition', () => {
    it('plays the four targets as one round, most targets won takes the point, then the leaderboard and the lobby', () => {
        const party = startStopTheClock();
        assert.equal(party.state.phase, 'competition');
        assert.equal(party.state.totalRounds, 1);

        const winners = ['host', 'host', 'host', 'guest'];
        winners.forEach((winner, target) => {
            playStopTheClockTarget(party, winner);
            const results = party.messages<RoundResultsPayload>(ServerMessage.RoundResults).at(-1)!;
            const isLast = target === winners.length - 1;
            assert.equal(results.isFinal, isLast);
            assert.equal(results.advancing === null, isLast, 'every target but the last goes on to the next');
            if (!isLast) {
                party.clock.advance(STOP_THE_CLOCK.SCORES_BREAK_MS);
                assert.equal(party.state.round.roundInGame, 1, 'still the same scoring round');
            }
        });
        const final = party.messages<RoundResultsPayload>(ServerMessage.RoundResults).at(-1)!;
        assert.equal(final.winnerId, 'host');
        assert.deepEqual(final.ranked.map((row) => [row.playerId, row.detail['wins']]), [['host', 3], ['guest', 1]]);
        party.clock.advance(STOP_THE_CLOCK.FINISH_ANIMATION_MS + COMPETITION.RESULT_DISPLAY_MS);

        assert.equal(party.state.phase, 'leaderboard');
        const board = party.messages<LeaderboardPayload>(ServerMessage.Leaderboard)[0]!;
        assert.deepEqual(board.rows.map((row) => [row.playerId, row.points, row.rank]), [
            ['host', 1, 1],
            ['guest', 0, 2]
        ]);

        party.clock.advance(COMPETITION.LEADERBOARD_DISPLAY_MS);
        assert.equal(party.state.phase, 'lobby');
        assert.equal(party.state.round.phase, 'idle');
        assert.equal(party.state.players.get('guest')?.ready, false, 'everyone re-confirms');
        assert.equal(party.state.players.get('host')?.points, 0);
    });

    it('level on targets won, the lower total takes the round', () => {
        const party = startStopTheClock();
        // Two targets each; the host loses theirs by far more than the guest does.
        playStopTheClockGame(party, [['host', 100], ['host', 100], ['guest', 300], ['guest', 300]]);
        const final = party.messages<RoundResultsPayload>(ServerMessage.RoundResults).at(-1)!;
        assert.equal(final.winnerId, 'guest');
        assert.deepEqual(final.ranked.map((row) => [row.playerId, row.detail['wins'], row.detail['totalErrorMs']]), [
            ['guest', 2, 200],
            ['host', 2, 600]
        ]);
    });

    it('missing a target costs a big penalty, but not the targets already won', () => {
        const party = startStopTheClock();
        playStopTheClockGame(party, [['host', 100], ['host', 100], ['host', 100]]);
        // The last target: only the guest stops, and wins it; the host never does.
        party.clock.advance(STOP_THE_CLOCK.SCORES_BREAK_MS);
        party.playToTiming();
        const { roundId, attempt } = party.state.round;
        const data = party.messages<RoundDataPayload<StopTheClockRound>>(ServerMessage.RoundData).at(-1)!;
        party.match.submitResult('guest', roundId, attempt, { elapsedMs: data.data.targetMs, timingSuspect: false });
        party.clock.advance(data.data.targetMs + STOP_THE_CLOCK.RESULT_GRACE_MS);

        const final = party.messages<RoundResultsPayload>(ServerMessage.RoundResults).at(-1)!;
        assert.equal(final.winnerId, 'host', 'three targets won beats one');
        const host = final.ranked.find((row) => row.playerId === 'host')!;
        assert.equal(host.reported, false);
        assert.equal(host.detail['totalErrorMs'], STOP_THE_CLOCK.MISSED_TARGET_MS);
        assert.deepEqual(final.noShow, [], 'ranked, so not listed again as a no-show');
    });

    it('a message for a finished attempt is refused as stale', () => {
        const party = startStopTheClock();
        const firstRoundId = party.state.round.roundId;
        playStopTheClockTarget(party, 'host');
        party.clock.advance(STOP_THE_CLOCK.SCORES_BREAK_MS);

        const stale = party.match.markReady('host', firstRoundId, 0);
        assert.equal(!stale.ok && stale.error.code, 'stale_round');
    });

    it('only the owner can skip the results screen', () => {
        const party = startStopTheClock(['host', 'guest'], ['stop-the-clock', 'log-dodge']);
        playStopTheClockGame(party, [['host'], ['host'], ['host'], ['host']]);
        party.clock.advance(STOP_THE_CLOCK.FINISH_ANIMATION_MS);
        const refused = party.match.skipResults('guest');
        assert.equal(!refused.ok && refused.error.code, 'not_owner');

        assert.equal(party.match.skipResults('host').ok, true);
        assert.equal(party.state.round.gameId, 'log-dodge');
        assert.equal(party.state.round.phase, 'ready-check');
    });

    it('the owner can skip to the next game mid-round; the unfinished round scores nothing', () => {
        const party = startStopTheClock(['host', 'guest'], ['stop-the-clock', 'log-dodge']);
        playStopTheClockTarget(party, 'host');
        party.clock.advance(STOP_THE_CLOCK.SCORES_BREAK_MS);
        party.playToTiming(); // the second target is in progress

        const refused = party.match.skipGame('guest');
        assert.equal(!refused.ok && refused.error.code, 'not_owner');

        const roundBefore = party.state.round.roundId;
        assert.equal(party.match.skipGame('host').ok, true);
        assert.equal(party.state.round.gameId, 'log-dodge');
        assert.equal(party.state.round.roundInGame, 1);
        assert.ok(party.state.round.roundId > roundBefore);
        assert.equal(party.state.players.get('host')?.points, 0, 'a target won is not the round won');

        const stale = party.match.markReady('host', roundBefore, 0);
        assert.equal(!stale.ok && stale.error.code, 'stale_round');
    });

    it('skipping the last game goes to the final leaderboard', () => {
        const party = startStopTheClock();
        assert.equal(party.match.skipGame('host').ok, true);
        assert.equal(party.state.phase, 'leaderboard');
        assert.equal(party.messages(ServerMessage.Leaderboard).length, 1);
        const refused = party.match.skipGame('host');
        assert.equal(!refused.ok && refused.error.code, 'wrong_phase');
    });

    it('the owner can take everyone back to the lobby from a round or the leaderboard', () => {
        const party = startStopTheClock();
        party.playToTiming();
        assert.equal(!party.match.backToLobby('guest').ok, true);
        assert.equal(party.match.backToLobby('host').ok, true);
        assert.equal(party.state.phase, 'lobby');
        assert.equal(party.state.round.phase, 'idle');
        const again = party.match.backToLobby('host');
        assert.equal(!again.ok && again.error.code, 'wrong_phase');

        party.readyUp();
        party.match.start('host');
        party.match.skipGame('host');
        assert.equal(party.state.phase, 'leaderboard');
        assert.equal(party.match.backToLobby('host').ok, true);
        assert.equal(party.state.phase, 'lobby');
    });

    it('when the owner drops mid-match, the next player takes over and play goes on', () => {
        const party = startStopTheClock(['host', 'guest', 'third']);
        party.members.markDisconnected('host');
        party.match.onPlayerGone('host');
        assert.equal(party.state.ownerId, 'guest');
        assert.deepEqual([...party.state.round.participants], ['guest', 'third']);
    });

    it('a reconnecting player is sent the current round data again', () => {
        const party = startStopTheClock();
        party.members.markDisconnected('guest');
        party.match.onPlayerGone('guest');
        party.members.markReconnected('guest');
        party.match.onPlayerReconnected('guest');
        assert.ok(party.sent.some((m) => m.to === 'guest' && m.type === ServerMessage.RoundData));
        assert.ok(party.state.round.participants.includes('guest'), 'back in the ready check');
    });

    it('live progress lands in state and is cleared for the next attempt', () => {
        const party = startStopTheClock();
        party.playToTiming();
        const { roundId, attempt } = party.state.round;
        party.match.submitProgress('host', roundId, attempt, { running: true });
        assert.equal(party.state.round.progress.get('host')?.values.get('running'), 1);

        playStopTheClockTarget(party, 'host');
        party.clock.advance(STOP_THE_CLOCK.SCORES_BREAK_MS);
        assert.equal(party.state.round.progress.size, 0);
    });

    it('the next round starts with an empty shared world, not the last round\'s', () => {
        const party = createPartyHarness(['host', 'guest']);
        party.lobby.setMode('host', 'custom', ['mage-battle']);
        party.readyUp();
        assert.equal(party.match.start('host').ok, true);
        party.playToTiming();
        const first = { roundId: party.state.round.roundId, attempt: party.state.round.attempt };
        party.clock.advance(1_000);
        const reply = party.match.handleAction('host', first.roundId, first.attempt, { type: 'press', atMs: 1_000 });
        assert.equal(reply.ok, true, JSON.stringify(reply));
        assert.ok(party.state.round.shared.size > 0, 'the press is in the shared world');

        for (const id of ['host', 'guest']) party.match.submitResult(id, first.roundId, first.attempt, {});
        party.clock.advance(MAGE_BATTLE.FINISH_ANIMATION_MS + COMPETITION.RESULT_DISPLAY_MS);
        // A press that missed leaves it 0-0, and a tiebreaker comes first: that must start empty too.
        const { roundId, attempt } = party.state.round;
        assert.ok(roundId !== first.roundId || attempt !== first.attempt, 'on to the next attempt');
        assert.equal(party.state.round.shared.size, 0);
    });
});
