import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TYPE_RACER } from '../src/shared/games/typeRacer/constants.js';
import { Competition } from '../src/server/competition/competition.js';
import { buildCustomPlaylist, buildRandomPlaylist } from '../src/server/competition/playlist.js';
import { hmacRollFace } from '../src/server/games/diceRolls.js';
import { playableGameIds, roundsForGame } from '../src/server/games/registry.js';

describe('playlists', () => {
    it('all eight built games are playable', () => {
        assert.deepEqual(playableGameIds().sort(), [
            'crusher-escalator',
            'cube-counter',
            'hex-drop',
            'log-dodge',
            'mage-battle',
            'minefield',
            'stop-the-clock',
            'type-racer-roulette'
        ]);
    });

    it('random mode plays every playable game, once each', () => {
        const playlist = buildRandomPlaylist();
        assert.equal(playlist.length, playableGameIds().length);
        assert.equal(new Set(playlist).size, playlist.length);
    });

    it('custom mode keeps the order and rejects repeats and unbuilt games', () => {
        assert.deepEqual(buildCustomPlaylist(['log-dodge', 'minefield']), {
            ok: true,
            playlist: ['log-dodge', 'minefield']
        });
        assert.equal(buildCustomPlaylist(['log-dodge', 'log-dodge']).ok, false);
        assert.equal(buildCustomPlaylist([]).ok, false);
    });
});

describe('competition', () => {
    it('each game is played for its own number of rounds', () => {
        const competition = new Competition(['stop-the-clock', 'cube-counter'], ['a']);
        const seen: string[] = [];
        do seen.push(competition.position()!.gameId);
        while (competition.advance());
        assert.equal(seen.length, roundsForGame('stop-the-clock') + roundsForGame('cube-counter'));
        assert.equal(competition.totalRounds, seen.length);
    });

    it('one point per round, ties left tied on the leaderboard', () => {
        const competition = new Competition(['stop-the-clock'], ['a', 'b', 'c']);
        competition.award('a');
        competition.award('b');
        competition.award(null);
        const board = competition.leaderboard();
        assert.deepEqual(board.rows.map((row) => row.rank), [1, 1, 3]);
        assert.equal(board.tied, true);
    });
});

describe('dice', () => {
    it('a roll is a valid face, and the same inputs always give the same roll', () => {
        for (let i = 0; i < 200; i++) {
            const face = hmacRollFace('nonce', 'p1', i);
            assert.ok(Number.isInteger(face) && face >= 1 && face <= TYPE_RACER.DICE_SIDES);
            assert.equal(face, hmacRollFace('nonce', 'p1', i));
        }
    });

    it('rolls are roughly fair', () => {
        const counts = new Array<number>(TYPE_RACER.DICE_SIDES).fill(0);
        const total = 6_000;
        for (let i = 0; i < total; i++) counts[hmacRollFace(`n${i}`, 'p', 0) - 1]! += 1;
        for (const count of counts) assert.ok(Math.abs(count - total / 6) < total * 0.04);
    });
});
