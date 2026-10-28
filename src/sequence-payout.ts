/** Independent Hi-Lo rounded-bank and Trading fee/carry replay from player-owned inputs and the public draw tape. */
import type { RoundProof } from './records.ts';
import type { OutcomeCheck } from './games.ts';
import { DECK_CODES, isCardCode } from './shoe.ts';
import { UnprovenPayoutError, PayoutTape, detailRecord, drawingSteps, authorizedSteps, integer, proofRefKey, requireEqual, type PayoutContext } from './payout-common.ts';
import type { HiloGameplay, TradingGameplay } from './gameplay.ts';
const HILO_CAP = 50_000_000;
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const hiRank = (card: string) => ranks.indexOf(card.slice(0, -1));
const missing = (what: string): OutcomeCheck => ({ checked: false, summary: null, errors: [], unproven: [what] });
function hiloSide(current: number, side: 'lo' | 'hi') {
  if (side === 'lo') return current === 0 ? { n: 1, kind: 'same', wins: (r: number) => r === 0 } : current === 12 ? { n: 12, kind: 'lower', wins: (r: number) => r < 12 } : { n: current + 1, kind: 'lower_or_same', wins: (r: number) => r <= current };
  return current === 12 ? { n: 1, kind: 'same', wins: (r: number) => r === 12 } : current === 0 ? { n: 12, kind: 'higher', wins: (r: number) => r > 0 } : { n: 13 - current, kind: 'higher_or_same', wins: (r: number) => r >= current };
}

export function checkHiloPayout(proof: RoundProof, context: PayoutContext): OutcomeCheck {
  const witness = context.gameplay;
  if (!witness || witness.kind !== 'hilo/rounded-v1' || !witness.complete) return missing('the complete player-owned Hi-Lo input record is not given');
  const detail = detailRecord(proof);
  if (!detail || detail.mapping !== 'hilo/rounded-v1') return missing('the historical Hi-Lo payout rule is not the rounded-bank rule');
  const w: HiloGameplay = witness, errors: string[] = [];
  try {
    if (!integer(w.stake, 1) || !isCardCode(w.initialCard) || !Array.isArray(w.guesses) || !w.guesses.length || w.guesses.some((g) => g !== 'lo' && g !== 'hi')) throw new Error('invalid player-owned Hi-Lo inputs');
    const all = authorizedSteps(proof, context, ['hilo-init', 'hilo-exchange', 'hilo-guess']);
    const prefix = all.filter((s) => s.nonce < w.startNonce);
    if (prefix.some((s) => context.authorizedDraws![String(s.nonce)]!.kind === 'hilo-guess')) throw new Error('a paid Hi-Lo guess precedes the player round anchor');
    if (all.filter((s) => s.nonce >= w.startNonce).some((s) => context.authorizedDraws![String(s.nonce)]!.kind !== 'hilo-guess')) throw new Error('a Hi-Lo guess is not bound to its own acknowledged choice');
    const previous = prefix.at(-1);
    if (previous) {
      const auth = context.authorizedDraws![String(previous.nonce)]!;
      if (!auth.card) throw new UnprovenPayoutError('the displayed Hi-Lo starting card is not recorded');
      requireEqual(errors, 'Hi-Lo starting card', w.initialCard, auth.card);
    } else {
      const previousState = w.cardFrom ? context.prior?.[proofRefKey(w.cardFrom)] : undefined;
      if (!previousState?.verified || !previousState.state?.hilo) throw new UnprovenPayoutError('the Hi-Lo starting card has no verified init, exchange or predecessor');
      requireEqual(errors, 'Hi-Lo predecessor card', w.initialCard, previousState.state.hilo.card);
    }
    let current = w.initialCard, bank = w.stake, lost = false, target = w.autoTarget;
    const steps = drawingSteps(proof, w.startNonce), cards = [current], kinds: string[] = [];
    if (steps.length !== w.guesses.length) throw new Error('Hi-Lo draws must have exactly one step per acknowledged guess');
    for (let i = 0; i < w.guesses.length; i++) {
      for (const change of w.targetChanges ?? []) if (change.beforeGuess === i) target = change.value;
      if (target !== null && !integer(target, 101, 100_000_000)) throw new Error('invalid Hi-Lo auto target');
      const currentRank = hiRank(current), side = hiloSide(currentRank, w.guesses[i]!);
      const factor = (n: number) => ({ num: BigInt(bank) * 13n * (i === 0 ? 99n : 1n), den: BigInt(n) * (i === 0 ? 100n : 1n) });
      if (['lo', 'hi'].every((s) => { const a = factor(hiloSide(currentRank, s as 'lo' | 'hi').n); return a.num > BigInt(HILO_CAP) * a.den; })) throw new Error('Hi-Lo guessed after both choices exceeded the cap');
      const tape = new PayoutTape(steps[i]!);
      current = DECK_CODES[tape.int(52)]!;
      const seenCard = context.authorizedDraws![String(steps[i]!.nonce)]!.card;
      if (!seenCard) throw new UnprovenPayoutError('an acknowledged Hi-Lo guess has no recorded displayed card');
      requireEqual(errors, 'Hi-Lo displayed guess card', current, seenCard); cards.push(current); kinds.push(side.kind);
      if (!side.wins(hiRank(current))) {
        lost = true; tape.finish();
        if (i !== w.guesses.length - 1 || w.ending !== 'lost') throw new Error('Hi-Lo continued or cashed out after a lost guess');
        break;
      }
      const exact = factor(side.n);
      if (exact.num > BigInt(HILO_CAP) * exact.den) bank = HILO_CAP;
      else {
        const whole = Number(exact.num / exact.den), remainder = Number((exact.num % exact.den) * 1_000_000n / exact.den);
        bank = whole + (remainder > 0 && tape.int(1_000_000) + 1 <= remainder ? 1 : 0);
      }
      tape.finish();
      const reached = target !== null && BigInt(bank) * 100n >= BigInt(w.stake) * BigInt(target);
      if (reached && (i !== w.guesses.length - 1 || w.ending !== 'target')) throw new Error('Hi-Lo continued after the acknowledged automatic cashout target');
      if (i === w.guesses.length - 1 && w.ending === 'target' && !reached) throw new Error('Hi-Lo claimed an automatic target it did not reach');
    }
    if (!lost && !['cashout', 'target', 'abandon'].includes(w.ending)) throw new Error('Hi-Lo ended as lost after only successful guesses');
    const payout = lost ? 0 : bank;
    requireEqual(errors, 'Hi-Lo stake', detail.stake, w.stake); requireEqual(errors, 'Hi-Lo cards', detail.cards, cards);
    requireEqual(errors, 'Hi-Lo choices', detail.guesses, kinds); requireEqual(errors, 'Hi-Lo payout', detail.payout, payout);
    requireEqual(errors, 'Hi-Lo rounded multiplier', detail.multiplier, bank / w.stake);
    requireEqual(errors, 'Hi-Lo outcome', detail.outcome, lost ? 'lost' : 'cashout');
    requireEqual(errors, 'Hi-Lo automatic ending', detail.auto ?? null, w.ending === 'target' || w.ending === 'abandon' ? w.ending : null);
    return { checked: true, summary: `Hi-Lo ${w.guesses.length} guesses, payout ${payout} cents`, errors, state: { hilo: { card: current } } };
  } catch (e) { if (e instanceof UnprovenPayoutError) return { checked: false, summary: null, errors: [], unproven: [e.message] }; return { checked: true, summary: 'invalid Hi-Lo payout replay', errors: [e instanceof Error ? e.message : String(e)] }; }
}

export function checkTradingPayout(proof: RoundProof, context: PayoutContext): OutcomeCheck {
  const witness = context.gameplay;
  if (!witness || witness.kind !== 'trading/carry99-v1' || !witness.complete) return missing('the complete player-owned Trading input record is not given');
  const detail = detailRecord(proof);
  if (!detail || detail.mapping !== 'trading/carry99-v1') return missing('the historical Trading record lacks versioned fee/carry data');
  const w: TradingGameplay = witness, errors: string[] = [], unproven: string[] = [];
  try {
    if (!integer(w.value, 1, 200_000_000) || !integer(w.chips, 0, w.value) || !integer(w.staked, w.chips) || !integer(w.carry, 0, 99) || (w.side !== 'up' && w.side !== 'down') || typeof w.ride !== 'boolean') throw new Error('invalid player-owned Trading inputs');
    if (w.carryFrom) {
      const prior = context.prior?.[proofRefKey(w.carryFrom)];
      if (!prior?.verified || !prior.state?.trading) unproven.push('the previous verified Trading carry proof is not given');
      else requireEqual(errors, 'Trading carry continuity', w.carry, prior.state.trading.carry);
    } else if (!w.carryKnown) unproven.push('the initial Trading commission carry is not independently known');
    const portfolioFrom = w.portfolioFrom ?? w.carryFrom;
    if (portfolioFrom || w.value > w.chips) {
      const prior = portfolioFrom ? context.prior?.[proofRefKey(portfolioFrom)] : undefined;
      if (!prior?.verified || !prior.state?.trading) unproven.push('the preceding verified Portfolio state is not given');
      else { requireEqual(errors, 'Trading Portfolio continuity', w.value, prior.state.trading.value + w.chips); requireEqual(errors, 'Trading outstanding stake continuity', w.staked, prior.state.trading.staked + w.chips); }
    } else if (w.staked !== w.chips) throw new Error('an opening Portfolio has an unexplained outstanding stake');
    const authorized = authorizedSteps(proof, context, ['trading-trade']);
    if (authorized.some((s) => s.nonce < w.startNonce)) throw new Error('an unexplained Trading draw precedes the player operation');
    const steps = drawingSteps(proof, w.startNonce);
    let payout = 0, carry = w.carry, after = 0, fee = 0, refunded = 0, active = 0, staked = 0;
    if (w.operation === 'trade') {
      if (w.value > 100_000_000 || steps.length !== 1) throw new Error('Trading requires exactly one draw step below the Portfolio cap');
      const tape = new PayoutTape(steps[0]!); const u = tape.int(990), seed = tape.int(0x1_0000_0000); tape.finish();
      const z = u % 495, move = (u < 495 ? 1 : -1) * (z < 99 ? 100 : 1 + Math.floor((z - 99) / 4));
      const delta = Number((BigInt(w.value) * BigInt(Math.abs(move)) + 50n) / 100n);
      after = move > 0 === (w.side === 'up') ? w.value + delta : w.value - delta;
      if (!w.ride && after > 0) { fee = Math.floor((w.carry + after) / 100); carry = (w.carry + after) % 100; payout = after - fee; }
      if (w.ride && after > 0) { active = after; staked = w.staked; }
      requireEqual(errors, 'Trading side', detail.side, w.side); requireEqual(errors, 'Trading move', detail.move, move); requireEqual(errors, 'Trading chart seed', detail.seed, seed);
      requireEqual(errors, 'Trading before', detail.before, w.value); requireEqual(errors, 'Trading after', detail.after, after); requireEqual(errors, 'Trading ride mode', detail.ride, w.ride);
      requireEqual(errors, 'Trading cashout', detail.cashout ?? null, !w.ride && after > 0 ? { value: after, fee, payout, by: 'auto' } : null);
    } else if (w.operation === 'cashout') {
      if (steps.length || w.value <= w.chips) throw new Error('Trading cashout must draw nothing and have traded value');
      after = w.value - w.chips; refunded = w.chips; fee = Math.floor((w.carry + after) / 100); carry = (w.carry + after) % 100; payout = after - fee;
      requireEqual(errors, 'Trading cashout', detail.cashout, { value: after, fee, payout, by: w.by ?? 'player' });
    } else throw new Error('unknown Trading operation');
    requireEqual(errors, 'Trading carry before', detail.carryBefore, w.carry); requireEqual(errors, 'Trading carry after', detail.carryAfter, carry);
    requireEqual(errors, 'Trading outstanding stake', detail.staked, w.staked); requireEqual(errors, 'Trading new chips', detail.chips, w.chips); requireEqual(errors, 'Trading refunds', detail.refunded, refunded);
    return { checked: true, summary: `Trading payout ${payout}, fee ${fee}, carry ${carry}`, errors, unproven, state: { trading: { carry, value: active, staked } } };
  } catch (e) { if (e instanceof UnprovenPayoutError) return { checked: false, summary: null, errors: [], unproven: [e.message] }; return { checked: true, summary: 'invalid Trading payout replay', errors: [e instanceof Error ? e.message : String(e)] }; }
}
