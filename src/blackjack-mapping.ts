import { replayBlackjack } from './blackjack-payout.ts';
import type { RoundProof } from './records.ts';
import type { OutcomeCheck, RoundCards } from './games.ts';
import { UnprovenPayoutError, authorizedSteps, drawingSteps, PayoutTape, integer, proofRefKey, requireEqual, type PayoutContext } from './payout-common.ts';
const weights = [33, 23, 16, 12, 9, 7];
const current = [[3,4,4,5,5,10],[4,4,5,5,6,12],[4,5,5,6,7,15],[5,5,6,7,8,20],[5,6,7,8,9,25],[6,7,8,9,10,25]];
const legacy = [[2,3,4,5,7,10],[2,3,4,6,8,12],[2,3,5,7,10,15],[3,4,6,8,12,20],[3,5,7,10,15,25],[4,6,8,12,20,25]];
const categories = ['le17','18','19','20','21','bj'];
export function replayBlackjackBoard(proof: RoundProof, start: number, old = false): Record<string, number> {
  const steps = drawingSteps(proof, start);
  if (steps.length !== 1) throw new Error('Multiplier Blackjack draws exactly one board per round');
  const tape = new PayoutTape(steps[0]!); let value = tape.int(100), index = 0; tape.finish();
  for (; index < weights.length - 1 && value >= weights[index]!; index++) value -= weights[index]!;
  const row = (old ? legacy : current)[index]!;
  return Object.fromEntries(categories.map((c, i) => [c, row[i]!]));
}
const code = (c: unknown): unknown => typeof c === 'string' ? c : c && typeof c === 'object' ? `${(c as { rank?: unknown }).rank}${(c as { suit?: unknown }).suit}` : c;

export function checkBlackjackPayout(proof: RoundProof, cards: RoundCards | null, context: PayoutContext): OutcomeCheck {
  const w = context.gameplay, outcome = proof.outcome as Record<string, unknown> | null;
  const meta = outcome?.payoutProof as Record<string, unknown> | null;
  const missing = (reason: string): OutcomeCheck => ({ checked: false, summary: 'blackjack cards only', errors: [], unproven: [reason] });
  if (!w || w.kind !== 'blackjack/payout-v1' || !w.complete) return missing('the complete player-owned blackjack wager/action record is not given');
  if (!meta || meta.version !== 'blackjack/payout-v1') return missing('this historical blackjack record does not contain versioned payout data');
  if (!cards || cards.length !== 1) return { checked: false, summary: null, errors: ['blackjack payout needs exactly one verified shoe slice'] };
  const errors: string[] = [], unproven: string[] = [];
  try {
    const multiplier = proof.gameId === 'blitz-solo';
    const allowed = multiplier ? ['multiplier/set-a-r1', 'multiplier/legacy'] : proof.gameId === 'freebet-solo' ? ['free-double/g7'] : ['solo/g7', 'solo/legacy'];
    if (!allowed.includes(w.rules)) throw new Error('blackjack payout rule does not match this table');
    requireEqual(errors, 'blackjack rule version', meta.rules, w.rules);
    const authorized = authorizedSteps(proof, context, multiplier ? ['blackjack-board'] : []);
    if (authorized.some((s) => s.nonce < w.startNonce)) throw new Error('an unexplained blackjack draw precedes the player deal');
    const board = multiplier ? replayBlackjackBoard(proof, w.startNonce, w.rules === 'multiplier/legacy') : undefined;
    if (!multiplier && drawingSteps(proof, w.startNonce).length) throw new Error('classic blackjack draws no round-stream random values');
    requireEqual(errors, 'blackjack multiplier board', meta.board, board ?? null);
    if (multiplier) for (const wager of w.boxes) {
      const from = w.carryFrom?.[String(wager.seat)];
      const previous = from ? context.prior?.[proofRefKey(from)] : undefined;
      // Absence is also a claim: a server must not erase an earned carry before the player sees the next DEAL.
      if (from) {
        if (previous?.verified && previous.state?.blackjack) requireEqual(errors, `box ${wager.seat} carried multiplier`, wager.pending, previous.state.blackjack[String(wager.seat)] ?? null);
        else unproven.push(`box ${wager.seat} has no independently verified multiplier predecessor`);
      } else if (w.initialSeats?.includes(wager.seat)) requireEqual(errors, `box ${wager.seat} initial multiplier`, wager.pending, null);
      else if (!w.carryKnown) unproven.push(`box ${wager.seat} has no independently verified multiplier predecessor`);
    }
    const replay = replayBlackjack({ rules: w.rules, boxes: w.boxes, actions: w.actions, insurance: w.insurance, cards: cards[0]!, board });
    const actualHands = Array.isArray(outcome!.hands) ? outcome!.hands.map((raw) => { const h = raw as Record<string, unknown>; return { seat: h.seat, cards: Array.isArray(h.cards) ? h.cards.map(code) : h.cards, bet: h.bet, outcome: h.outcome, payout: h.payout, ...((h.multiplierApplied ?? h.multiplier) !== undefined ? { multiplierApplied: h.multiplierApplied ?? h.multiplier } : {}) }; }) : null;
    const expectedHands = replay.boxes.flatMap((b) => b.hands.map((h) => ({ seat: h.seat, cards: h.cards, bet: h.bet, outcome: h.outcome, payout: h.payout, ...(h.multiplierApplied !== undefined ? { multiplierApplied: h.multiplierApplied } : {}) })));
    requireEqual(errors, 'blackjack hand payouts', actualHands, expectedHands);
    requireEqual(errors, 'blackjack side payouts', outcome!.sideBets, replay.boxes.flatMap((b) => b.sideBets));
    requireEqual(errors, 'blackjack total stake', outcome!.totalBet, replay.totalBet); requireEqual(errors, 'blackjack total return', outcome!.totalWin, replay.totalWin);
    requireEqual(errors, 'blackjack dealer total', outcome!.dealerTotal, replay.dealerTotal);
    const earned = replay.boxes.flatMap((b) => b.earned ? [{ seat: b.seat, ...b.earned }] : []);
    requireEqual(errors, 'blackjack earned multipliers', meta.earned, earned);
    const ins = replay.boxes.flatMap((b) => b.insurance ? [{ seat: b.seat, ...b.insurance }] : []);
    requireEqual(errors, 'blackjack insurance payouts', meta.insurance, ins);
    return { checked: true, summary: `blackjack payouts ${replay.totalWin} on ${replay.totalBet} cents`, errors, unproven, state: { blackjack: Object.fromEntries(replay.boxes.map((b) => [String(b.seat), b.earned])) } };
  } catch (e) { if (e instanceof UnprovenPayoutError) return { checked: false, summary: null, errors: [], unproven: [e.message] }; return { checked: true, summary: 'invalid blackjack payout replay', errors: [e instanceof Error ? e.message : String(e)] }; }
}
