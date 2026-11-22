/**
 * Skribbl's game flow on a fake clock: the lobby, turns, the secret word,
 * guesses, hints, scoring, the drawing, and players coming and going.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeDrawPacket, decodeDrawPacket, type CanvasOp } from '../../src/shared/standalone/skribbl/canvas.js';
import { SKRIBBL_CHAT, SKRIBBL_TIMING } from '../../src/shared/standalone/skribbl/constants.js';
import {
    SkribblBytes,
    SkribblMessage,
    type ChatPayload,
    type GameEndedPayload,
    type TurnEndedPayload,
    type WordChoicesPayload,
    type WordPayload
} from '../../src/shared/standalone/skribbl/protocol.js';
import { createSkribblHarness as createDefaultHarness } from '../support/skribblHarness.js';

/** The timings and points below are worked out for an 80 s turn, so pin it rather than follow the default. */
const DRAW_MS = 80_000;
const createSkribblHarness = (...args: Parameters<typeof createDefaultHarness>) => {
    const h = createDefaultHarness(...args);
    h.state.settings.drawTimeSec = DRAW_MS / 1000;
    return h;
};
const stroke: CanvasOp[] = [
    { op: 'begin', color: 1, size: 2, x: 10, y: 10 },
    { op: 'points', points: [{ x: 20, y: 20, dtMs: 16 }] }
];

/** Start a game and have the first drawer pick the first word ("polar bear"). */
const startDrawing = (players = ['ada', 'bo', 'cy']) => {
    const h = createSkribblHarness(players);
    assert.equal(h.game.start('ada').ok, true);
    const choose = h.game.chooseWord('ada', h.state.turn.turnId, 0);
    assert.deepEqual(choose, { ok: true, value: { word: 'polar bear' } });
    return h;
};

const stateText = (h: ReturnType<typeof createSkribblHarness>) => JSON.stringify(h.state.toJSON()).toLowerCase();

describe('skribbl lobby', () => {
    it('lets only the owner start, and only with two connected players', () => {
        const solo = createSkribblHarness(['ada']);
        assert.equal(solo.state.canStart, false);
        assert.equal(solo.state.blockedReason, 'not_enough_players');
        assert.equal((solo.game.start('ada') as { error: { code: string } }).error.code, 'not_enough_players');

        const h = createSkribblHarness(['ada', 'bo']);
        assert.equal(h.state.canStart, true);
        assert.equal((h.game.start('bo') as { error: { code: string } }).error.code, 'not_owner');
        assert.equal(h.game.start('ada').ok, true);
        assert.equal(h.state.canStart, false);
        assert.equal((h.game.start('ada') as { error: { code: string } }).error.code, 'wrong_phase');
    });

    it('clamps settings, and only the owner changes them in the lobby', () => {
        const h = createSkribblHarness(['ada', 'bo']);
        const updated = h.lobby.updateSettings('ada', { rounds: 99, drawTimeSec: 5, hints: 1 });
        assert.deepEqual(updated, { ok: true, value: { rounds: 10, drawTimeSec: 30, wordChoices: 3, hints: 1 } });
        assert.equal(h.lobby.updateSettings('ada', { drawTimeSec: 500 }).ok && h.state.settings.drawTimeSec, 90);
        assert.equal(h.lobby.updateSettings('ada', { drawTimeSec: 50 }).ok && h.state.settings.drawTimeSec, 45);
        assert.equal(h.lobby.updateSettings('bo', { rounds: 2 }).ok, false);
        h.game.start('ada');
        assert.equal(h.lobby.updateSettings('ada', { rounds: 2 }).ok, false);
    });
});

describe('skribbl turns', () => {
    it('offers the words to the drawer alone, and never puts them in state', () => {
        const h = createSkribblHarness(['ada', 'bo', 'cy']);
        h.game.start('ada');
        assert.equal(h.state.phase, 'playing');
        assert.equal(h.state.turn.phase, 'choosing');
        assert.equal(h.state.turn.drawerId, 'ada', 'the first to join draws first');
        assert.equal(h.state.turn.round, 1);
        assert.equal(h.state.turn.endsAtMs, SKRIBBL_TIMING.CHOOSE_MS);

        const choices = h.sent.filter((m) => m.type === SkribblMessage.WordChoices);
        assert.equal(choices.length, 1);
        assert.equal(choices[0]!.to, 'ada');
        assert.deepEqual((choices[0]!.payload as WordChoicesPayload).words, ['polar bear', 'cat', 'elephant']);
        for (const word of ['polar bear', 'cat', 'elephant']) assert.ok(!stateText(h).includes(word));

        assert.equal(h.game.chooseWord('bo', h.state.turn.turnId, 0).ok, false, 'not the drawer');
        assert.equal(h.game.chooseWord('ada', h.state.turn.turnId + 1, 0).ok, false, 'stale turn');
        assert.equal(h.game.chooseWord('ada', h.state.turn.turnId, 7).ok, false, 'no such choice');
    });

    it('picks a word for a drawer who takes too long', () => {
        const h = createSkribblHarness(['ada', 'bo']);
        h.game.start('ada');
        h.clock.advance(SKRIBBL_TIMING.CHOOSE_MS);
        assert.equal(h.state.turn.phase, 'drawing');
        assert.equal(h.state.turn.wordPattern, '_____ ____');
        assert.equal((h.messagesTo('ada', SkribblMessage.Word)[0]?.payload as WordPayload).word, 'polar bear');
    });

    it('shows guessers the pattern only, and the drawer the word', () => {
        const h = startDrawing();
        assert.equal(h.state.turn.phase, 'drawing');
        assert.equal(h.state.turn.wordPattern, '_____ ____');
        assert.equal(h.state.turn.endsAtMs, DRAW_MS, 'chosen at once, at time 0');
        assert.equal(h.messagesTo('ada', SkribblMessage.Word).length, 1);
        assert.equal(h.messagesTo('bo', SkribblMessage.Word).length, 0);
        assert.ok(!stateText(h).includes('polar'));
    });

    it('judges guesses: wrong ones are shown, a right one is hidden and scores', () => {
        const h = startDrawing();
        assert.deepEqual(h.game.say('bo', 'penguin'), { ok: true, value: { verdict: 'sent' } });
        h.clock.advance(1_000);
        assert.deepEqual(h.game.say('bo', 'polar beer'), { ok: true, value: { verdict: 'close' } });
        h.clock.advance(9_000);
        assert.deepEqual(h.game.say('bo', 'Polar-Bear!'), { ok: true, value: { verdict: 'correct' } });

        const chat = h.sent.filter((m) => m.type === SkribblMessage.Chat).map((m) => m.payload as ChatPayload);
        assert.deepEqual(chat.slice(0, 2).map((c) => c.kind === 'message' && c.text), ['penguin', 'polar beer']);
        assert.equal(chat[2]?.kind, 'guessed');
        assert.ok(!chat.some((c) => c.kind === 'message' && c.text.includes('Bear')), 'the right guess is never shown');

        assert.deepEqual([...h.state.turn.guessed], ['bo']);
        assert.equal(h.members.get('bo')!.points, 455, '70 s of 80 left, first to guess');
        assert.equal((h.messagesTo('bo', SkribblMessage.Word)[0]?.payload as WordPayload).word, 'polar bear');
        assert.equal(h.messagesTo('cy', SkribblMessage.Word).length, 0);
    });

    it('keeps the drawer and those who guessed in their own channel, and stops them spelling the word', () => {
        const h = startDrawing();
        h.game.say('bo', 'polar bear');
        h.clock.advance(SKRIBBL_CHAT.MIN_INTERVAL_MS);
        assert.equal(h.game.say('ada', 'nice one').ok, true);
        const line = h.sent.filter((m) => m.type === SkribblMessage.Chat && (m.payload as ChatPayload).kind === 'message');
        assert.deepEqual(line.map((m) => m.to).sort(), ['ada', 'bo']);
        assert.equal((line[0]!.payload as { channel: string }).channel, 'guessed');

        h.clock.advance(SKRIBBL_CHAT.MIN_INTERVAL_MS);
        const leak = h.game.say('bo', 'it is a POLAR BEAR');
        assert.equal(!leak.ok && leak.error.code, 'reveals_word');
    });

    it('refuses chat that comes too fast, or is empty', () => {
        const h = createSkribblHarness(['ada', 'bo']);
        assert.equal(h.game.say('bo', 'hi').ok, true);
        const fast = h.game.say('bo', 'hi again');
        assert.equal(!fast.ok && fast.error.code, 'rate_limited');
        h.clock.advance(SKRIBBL_CHAT.MIN_INTERVAL_MS);
        const empty = h.game.say('bo', '   ');
        assert.equal(!empty.ok && empty.error.code, 'invalid_payload');
    });

    it('reveals hint letters at even times through the turn', () => {
        const h = startDrawing();
        // Two hints over 80 s: at 26,667 ms and 53,333 ms.
        h.clock.advance(26_666);
        assert.equal(h.state.turn.wordPattern, '_____ ____');
        h.clock.advance(1);
        assert.equal(h.state.turn.wordPattern, 'p____ ____');
        h.clock.advance(26_666);
        assert.equal(h.state.turn.wordPattern, 'po___ ____');
        assert.ok(!stateText(h).includes('polar'));
    });

    it('ends the turn once everyone has guessed, scores the drawer, and moves on', () => {
        const h = startDrawing();
        h.clock.advance(20_000);
        h.game.say('bo', 'polar bear');
        h.clock.advance(20_000);
        h.game.say('cy', 'polar bear');

        assert.equal(h.state.turn.phase, 'reveal');
        assert.equal(h.state.turn.wordPattern, 'polar bear', 'the word is public once the turn ends');
        const ended = h.sent.find((m) => m.type === SkribblMessage.TurnEnded)!.payload as TurnEndedPayload;
        assert.equal(ended.reason, 'all-guessed');
        assert.equal(ended.word, 'polar bear');
        const bo = h.members.get('bo')!.points;
        const cy = h.members.get('cy')!.points;
        assert.ok(bo > cy, 'the earlier guess scores more');
        assert.equal(h.members.get('ada')!.points, Math.round((bo + cy) / 2 / 5) * 5);
        assert.deepEqual(ended.points.map((p) => p.playerId), ['bo', 'ada', 'cy']);

        h.clock.advance(SKRIBBL_TIMING.REVEAL_MS);
        assert.equal(h.state.turn.phase, 'choosing');
        assert.equal(h.state.turn.drawerId, 'bo');
        assert.deepEqual([...h.state.turn.guessed], []);
        const choices = h.messagesTo('bo', SkribblMessage.WordChoices).at(-1)!.payload as WordChoicesPayload;
        assert.deepEqual(choices.words, ['T-rex', 'apple', 'lemon'], 'no word is offered twice in a game');
    });

    it('ends the turn when time runs out, and the drawer scores nothing if nobody got it', () => {
        const h = startDrawing();
        h.clock.advance(DRAW_MS);
        const ended = h.sent.find((m) => m.type === SkribblMessage.TurnEnded)!.payload as TurnEndedPayload;
        assert.equal(ended.reason, 'time');
        assert.equal(h.members.get('ada')!.points, 0);
    });

    it('plays every player once per round, then shows the podium, then the lobby', () => {
        const h = createSkribblHarness(['ada', 'bo']);
        h.lobby.updateSettings('ada', { rounds: 2 });
        h.game.start('ada');
        const drawers: string[] = [];
        for (let turn = 0; turn < 4; turn++) {
            drawers.push(h.state.turn.drawerId);
            assert.equal(h.state.turn.round, Math.floor(turn / 2) + 1);
            h.clock.advance(SKRIBBL_TIMING.CHOOSE_MS + DRAW_MS + SKRIBBL_TIMING.REVEAL_MS);
        }
        assert.deepEqual(drawers, ['ada', 'bo', 'ada', 'bo']);
        assert.equal(h.state.phase, 'podium');
        const ended = h.sent.find((m) => m.type === SkribblMessage.GameEnded)!.payload as GameEndedPayload;
        assert.equal(ended.reason, 'finished');
        assert.deepEqual(ended.rows.map((r) => r.rank), [1, 1], 'nobody scored: a tie');

        h.clock.advance(SKRIBBL_TIMING.PODIUM_MS);
        assert.equal(h.state.phase, 'lobby');
        assert.equal(h.state.turn.phase, 'idle');
        assert.equal(h.state.canStart, true);
    });

    it('lets the owner stop the game at any point', () => {
        const h = startDrawing();
        assert.equal(h.game.returnToLobby('bo').ok, false);
        assert.equal(h.game.returnToLobby('ada').ok, true);
        assert.equal(h.state.phase, 'lobby');
        assert.equal(h.clock.pendingCount, 0, 'no timer survives');
    });
});

describe('skribbl drawing', () => {
    it('relays the drawer’s packets to everyone else, and keeps them', () => {
        const h = startDrawing();
        const bytes = encodeDrawPacket({ turnId: h.state.turn.turnId, ops: stroke });
        h.game.draw('ada', bytes);
        const relayed = h.sent.filter((m) => m.type === SkribblBytes.Draw);
        assert.equal(relayed.length, 1);
        assert.equal(relayed[0]!.except, 'ada');
        assert.equal(relayed[0]!.payload, bytes, 'the same bytes, untouched');
    });

    it('drops packets from anyone but the drawer, for another turn, or malformed', () => {
        const h = startDrawing();
        const turnId = h.state.turn.turnId;
        h.game.draw('bo', encodeDrawPacket({ turnId, ops: stroke }));
        h.game.draw('ada', encodeDrawPacket({ turnId: turnId - 1, ops: stroke }));
        h.game.draw('ada', new Uint8Array([1, 2, 3]));
        h.game.draw('ada', encodeDrawPacket({ turnId, ops: [{ op: 'points', points: [{ x: 1, y: 1, dtMs: 0 }] }] }));
        assert.equal(h.sent.filter((m) => m.type === SkribblBytes.Draw).length, 0);
    });

    it('refuses drawing before a word is chosen', () => {
        const h = createSkribblHarness(['ada', 'bo']);
        h.game.start('ada');
        h.game.draw('ada', encodeDrawPacket({ turnId: h.state.turn.turnId, ops: stroke }));
        assert.equal(h.sent.filter((m) => m.type === SkribblBytes.Draw).length, 0);
    });
});

describe('skribbl players coming and going', () => {
    it('lets a newcomer play at once: they see the drawing so far, guess, and draw next round', () => {
        const h = startDrawing(['ada', 'bo']);
        h.game.draw('ada', encodeDrawPacket({ turnId: h.state.turn.turnId, ops: stroke }));
        h.join('dee');
        assert.equal(h.members.get('dee')!.isSpectator, false);
        const snapshot = h.messagesTo('dee', SkribblBytes.Canvas)[0]!.payload as Uint8Array;
        // The catch-up drawing is shown at once, so it carries no pacing.
        assert.deepEqual(decodeDrawPacket(snapshot)?.ops, [
            { op: 'clear' },
            stroke[0],
            { op: 'points', points: [{ x: 20, y: 20, dtMs: 0 }] }
        ]);
        assert.equal(h.messagesTo('dee', SkribblMessage.Word).length, 0);

        assert.deepEqual(h.game.say('dee', 'polar bear'), { ok: true, value: { verdict: 'correct' } });
        assert.equal(h.state.turn.phase, 'drawing', 'bo has not guessed yet');

        h.clock.advance(DRAW_MS + SKRIBBL_TIMING.REVEAL_MS);
        assert.equal(h.state.turn.drawerId, 'bo', 'dee waits for the next round');
        h.clock.advance(SKRIBBL_TIMING.CHOOSE_MS + DRAW_MS + SKRIBBL_TIMING.REVEAL_MS);
        assert.equal(h.state.turn.round, 2);
        assert.equal(h.state.turn.drawerId, 'ada');
    });

    it('gives a dropped drawer a grace period, and hands back the word and drawing on return', () => {
        const h = startDrawing();
        h.game.draw('ada', encodeDrawPacket({ turnId: h.state.turn.turnId, ops: stroke }));
        h.drop('ada');
        h.clock.advance(SKRIBBL_TIMING.DRAWER_GRACE_MS - 1);
        assert.equal(h.state.turn.phase, 'drawing');
        h.reconnect('ada');
        assert.equal(h.messagesTo('ada', SkribblMessage.Word).length, 2);
        assert.equal(h.messagesTo('ada', SkribblBytes.Canvas).length, 1);
        h.clock.advance(SKRIBBL_TIMING.DRAWER_GRACE_MS);
        assert.equal(h.state.turn.phase, 'drawing', 'the grace was cancelled');
    });

    it('gives up the turn if the drawer does not come back in time', () => {
        const h = startDrawing();
        h.game.say('bo', 'polar bear');
        h.drop('ada');
        h.clock.advance(SKRIBBL_TIMING.DRAWER_GRACE_MS);
        const ended = h.sent.find((m) => m.type === SkribblMessage.TurnEnded)!.payload as TurnEndedPayload;
        assert.equal(ended.reason, 'drawer-left');
        assert.equal(h.members.get('ada')!.points, 0, 'a drawer who left scores nothing');
        assert.ok(h.members.get('bo')!.points > 0, 'guessers keep their points');
    });

    it('re-sends the word choices to a drawer who reconnects while choosing', () => {
        const h = createSkribblHarness(['ada', 'bo', 'cy']);
        h.game.start('ada');
        h.drop('ada');
        h.reconnect('ada');
        assert.equal(h.messagesTo('ada', SkribblMessage.WordChoices).length, 2);
    });

    it('ends the turn when the last guesser who had not guessed leaves', () => {
        const h = startDrawing();
        h.game.say('bo', 'polar bear');
        h.leave('cy');
        assert.equal(h.state.turn.phase, 'reveal');
    });

    it('ends the game when too few players are left', () => {
        const h = startDrawing(['ada', 'bo']);
        h.leave('bo');
        assert.equal(h.state.phase, 'podium');
        const ended = h.sent.find((m) => m.type === SkribblMessage.GameEnded)!.payload as GameEndedPayload;
        assert.equal(ended.reason, 'not_enough_players');
    });

    it('skips a drawer who is disconnected when their turn comes', () => {
        const h = startDrawing(['ada', 'bo', 'cy']);
        h.drop('bo');
        h.clock.advance(DRAW_MS + SKRIBBL_TIMING.REVEAL_MS);
        assert.equal(h.state.turn.drawerId, 'cy');
    });
});
