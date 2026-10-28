/** Literal edge vectors independent of the private implementations. */
import { describe, expect, it } from './harness.ts';
import { replayBlackjack } from '../src/blackjack-payout.ts';
import { checkHiloPayout } from '../src/sequence-payout.ts';
import { checkBaccaratPayout } from '../src/baccarat-payout.ts';
import { DECK_CODES } from '../src/shoe.ts';
import type { RoundProof } from '../src/records.ts';

const base = { v: 1, alg: 'fairshoe/v1', lib: 'fairshoe@1.2.0', id: 'arithmetic', gameId: '', roundId: 'arithmetic-round', seedId: 'arithmetic-seed', serverSeedHash: '', clientSeed: 'player', clientSeedBy: 'player', serverSeed: null, steps: [], shoes: [], outcome: null, engineVersion: 1, at: 1 } as RoundProof;

describe('public payout edge vectors', () => {
  it('R1 consumes a carry only on split hand zero, even when hand one wins', () => {
    const input = { rules: 'multiplier/set-a-r1' as const, boxes: [{ seat: 0, main: 100, pp: 0, p21: 0, pending: { value: 10, coversUpTo: 50, category: '20' } }], cards: ['8S', '10H', '8D', '7C', '7S', '10D'], actions: [{ seat: 0, hand: 0, action: 'split' as const, at: 4 }, { seat: 0, hand: 0, action: 'stand' as const, at: 5 }, { seat: 0, hand: 1, action: 'stand' as const, at: 6 }], insurance: [], board: { le17: 3, '18': 4, '19': 4, '20': 5, '21': 5, bj: 10 } };
    const replay = replayBlackjack(input);
    expect(replay.boxes[0]!.hands.map((h) => h.payout)).toEqual([0, 200]);
    expect(replay.boxes[0]!.earned).toEqual({ value: 4, coversUpTo: 100, category: '18' });
    expect(replayBlackjack({ ...input, rules: 'multiplier/legacy' }).boxes[0]!.hands.map((h) => h.payout)).toEqual([0, 650]);
  });

  it('a covered blackjack pays only the covered multiplier plus floored 3:2 on the excess', () => {
    const replay = replayBlackjack({ rules: 'multiplier/set-a-r1', boxes: [{ seat: 0, main: 101, pp: 0, p21: 0, pending: { value: 3, coversUpTo: 50, category: '18' } }], cards: ['AS', '9H', 'KD', '7C'], actions: [], insurance: [], board: { le17: 3, '18': 4, '19': 4, '20': 5, '21': 5, bj: 10 } });
    expect(replay.totalBet).toBe(202);
    expect(replay.totalWin).toBe(101 + 50 * 3 + 76);
    expect(replay.boxes[0]!.earned).toEqual({ value: 10, coversUpTo: 101, category: 'bj' });
  });

  it('Hi-Lo continues from 21 rounded cents, not from the earlier unrounded 21.45', () => {
    const proof: RoundProof = { ...base, gameId: 'hilo', steps: [{ nonce: 0, kind: 'init', status: 'ok', words: 1, draws: [{ n: 52, v: DECK_CODES.indexOf('2S') }] }, { nonce: 1, kind: 'act', status: 'ok', words: 2, draws: [{ n: 52, v: 2 }, { n: 1_000_000, v: 600000 }] }, { nonce: 2, kind: 'act', status: 'ok', words: 2, draws: [{ n: 52, v: 3 }, { n: 1_000_000, v: 900000 }] }], outcome: { detail: { mapping: 'hilo/rounded-v1', stake: 20, cards: ['2S', '3S', '4S'], guesses: ['higher', 'higher_or_same'], multiplier: 1.1, payout: 22, outcome: 'cashout' } } };
    const context = { authorizedDraws: { '0': { kind: 'hilo-init' as const, card: '2S' }, '1': { kind: 'hilo-guess' as const, card: '3S' }, '2': { kind: 'hilo-guess' as const, card: '4S' } }, gameplay: { kind: 'hilo/rounded-v1' as const, complete: true, stake: 20, initialCard: '2S', startNonce: 1, guesses: ['hi', 'hi'] as Array<'hi'>, ending: 'cashout' as const, autoTarget: null } };
    expect(checkHiloPayout(proof, context)).toMatchObject({ checked: true, errors: [] });
    const wrong = JSON.parse(JSON.stringify(proof)) as RoundProof;
    (wrong.outcome as { detail: { payout: number } }).detail.payout = 23;
    expect(checkHiloPayout(wrong, context).errors.length > 0).toBe(true);
  });

  it('Multiplier Baccarat independently applies the combined win cap after fees and stake returns', () => {
    const identities = ['4S', '3D', '4H', '5C'], deck = [...DECK_CODES];
    const draws = [{ n: 10000, v: 0 }];
    identities.forEach((c, i) => { const at = deck.indexOf(c); draws.push({ n: 52 - i, v: at - i }, { n: 10000, v: 9999 }); [deck[i], deck[at]] = [deck[at]!, deck[i]!]; });
    const products = { player: 100, banker: 100, tie: 10000, playerPair: 100, bankerPair: 100 };
    const bets = { player: 10000, tie: 5000 };
    const detail = { table: 1, strikes: identities.map((card) => ({ card, multiplier: 10 })), fee: 7500, multiplier: 10000, payoutProof: { version: 'baccarat/payout-v1', bets, products, staked: 15000, fee: 7500, returned: 50015000, payouts: [{ spot: 'player', stake: 10000, payout: 10000, outcome: 'push', multiplier: 1, fee: 5000 }, { spot: 'tie', stake: 5000, payout: 50005000, outcome: 'win', multiplier: 10000, fee: 2500, capped: true }] } };
    const proof: RoundProof = { ...base, gameId: 'blitz-baccarat-max', steps: [{ nonce: 0, kind: 'act', status: 'ok', words: draws.length, draws }], outcome: { detail } };
    expect(checkBaccaratPayout(proof, [identities], { authorizedDraws: { '0': { kind: 'baccarat-deal' } }, baccaratBets: bets, baccaratNonce: 0, baccaratSeedId: proof.seedId, shoeStepIndex: 0, shoeSteps: 1 })).toMatchObject({ checked: true, errors: [] });
    detail.payoutProof.payouts[1]!.payout++;
    expect(checkBaccaratPayout(proof, [identities], { authorizedDraws: { '0': { kind: 'baccarat-deal' } }, baccaratBets: bets, baccaratNonce: 0, baccaratSeedId: proof.seedId, shoeStepIndex: 0, shoeSteps: 1 }).errors.length > 0).toBe(true);
  });
});
