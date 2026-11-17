/**
 * A whole competition through the room's controllers: lobby rules, rounds,
 * points, results screens, the leaderboard and back to the lobby.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COMPETITION } from '../src/shared/constants.js';
import { MAGE_BATTLE } from '../src/shared/games/mageBattle/constants.js';
import type { StopTheClockRound } from '../src/shared/games/stopTheClock.js';
import {
    ServerMessage,
    type LeaderboardPayload,
    type RoundDataPayload,
    type RoundResultsPayload
} from '../src/shared/protocol.js';
import { createPartyHarness } from './support/partyHarness.js';

/** Play one Stop the Clock round in which `winner` is exact and everyone else is way off. */
const playStopTheClockRound = (party: ReturnType<typeof createPartyHarness>, winner: string) => {
    party.playToTiming();
    const { roundId, attempt, participants } = party.state.round;
    const data = party.messages<RoundDataPayload<StopTheClockRound>>(ServerMessage.RoundData).at(-1)!;
    for (const id of participants) {
        const elapsedMs = id === winner ? data.data.targetMs : 0;
        party.match.submitResult(id, roundId, attempt, { elapsedMs, timingSuspect: false });
    }
};

const startStopTheClock = (players = ['host', 'guest']) => {
    const party = createPartyHarness(players);
    party.lobby.setMode('host', 'custom', ['stop-the-clock']);
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
    it('plays every round, one point each, then shows the leaderboard and returns to the lobby', () => {
        const party = startStopTheClock();
        assert.equal(party.state.phase, 'competition');
        assert.equal(party.state.totalRounds, 4);

        for (let round = 1; round <= 4; round++) {
            assert.equal(party.state.round.roundInGame, round);
            playStopTheClockRound(party, round === 4 ? 'guest' : 'host');
            const results = party.messages<RoundResultsPayload>(ServerMessage.RoundResults).at(-1)!;
            assert.equal(results.isFinal, true);
            assert.ok(results.nextRoundAtServerMs !== null);
            party.clock.advance(COMPETITION.RESULT_DISPLAY_MS);
        }

        assert.equal(party.state.phase, 'leaderboard');
        const board = party.messages<LeaderboardPayload>(ServerMessage.Leaderboard)[0]!;
        assert.deepEqual(board.rows.map((row) => [row.playerId, row.points, row.rank]), [
            ['host', 3, 1],
            ['guest', 1, 2]
        ]);
        assert.equal(party.state.players.get('host')?.points, 3);

        party.clock.advance(COMPETITION.LEADERBOARD_DISPLAY_MS);
        assert.equal(party.state.phase, 'lobby');
        assert.equal(party.state.round.phase, 'idle');
        assert.equal(party.state.players.get('guest')?.ready, false, 'everyone re-confirms');
        assert.equal(party.state.players.get('host')?.points, 0);
    });

    it('a message for a finished round is refused as stale', () => {
        const party = startStopTheClock();
        const firstRoundId = party.state.round.roundId;
        playStopTheClockRound(party, 'host');
        party.clock.advance(COMPETITION.RESULT_DISPLAY_MS);

        const stale = party.match.markReady('host', firstRoundId, 0);
        assert.equal(!stale.ok && stale.error.code, 'stale_round');
    });

    it('only the owner can skip the results screen', () => {
        const party = startStopTheClock();
        playStopTheClockRound(party, 'host');
        const refused = party.match.skipResults('guest');
        assert.equal(!refused.ok && refused.error.code, 'not_owner');

        assert.equal(party.match.skipResults('host').ok, true);
        assert.equal(party.state.round.roundInGame, 2);
        assert.equal(party.state.round.phase, 'ready-check');
    });

    it('the owner can skip to the next game mid-round; the unfinished round scores nothing', () => {
        const party = createPartyHarness(['host', 'guest']);
        party.lobby.setMode('host', 'custom', ['stop-the-clock', 'log-dodge']);
        party.readyUp();
        party.match.start('host');
        playStopTheClockRound(party, 'host');
        party.clock.advance(COMPETITION.RESULT_DISPLAY_MS);
        party.playToTiming(); // round 2 is in progress

        const refused = party.match.skipGame('guest');
        assert.equal(!refused.ok && refused.error.code, 'not_owner');

        const roundBefore = party.state.round.roundId;
        assert.equal(party.match.skipGame('host').ok, true);
        assert.equal(party.state.round.gameId, 'log-dodge');
        assert.equal(party.state.round.roundInGame, 1);
        assert.ok(party.state.round.roundId > roundBefore);
        assert.equal(party.state.players.get('host')?.points, 1, 'points so far are kept');

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

        playStopTheClockRound(party, 'host');
        party.clock.advance(COMPETITION.RESULT_DISPLAY_MS);
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
