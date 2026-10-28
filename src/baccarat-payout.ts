/** Payout replay from committed cards, recorded strikes and the player's own accepted board. */
import { DECK_CODES, baccaratValue } from './shoe.ts';
import { MULTIPLIER_CONFIGS, type GuardMultiplierConfig } from './guard-weights.ts';
import { UnprovenPayoutError, authorizedSteps, PayoutTape, equal, integer, requireEqual, type PayoutContext } from './payout-common.ts';
import type { RoundProof } from './records.ts';
import type { OutcomeCheck, RoundCards } from './games.ts';

const variants: Record<string, GuardMultiplierConfig['id']> = { 'blitz-baccarat': 'multiplier', 'blitz-baccarat-max': 'max', 'jade-baccarat': 'jade', 'gold-baccarat': 'gold' };
const weighted = <T extends { weight: number }>(items: readonly T[], tape: PayoutTape): T => {
  let r = tape.int(items.reduce((sum, v) => sum + v.weight, 0));
  for (const item of items) { if (r < item.weight) return item; r -= item.weight; }
  throw new Error('unreachable weighted draw');
};
export function replayBaccaratStrike(gameId: string, tape: PayoutTape): Array<{ card: string; multiplier: number }> {
  const cfg = MULTIPLIER_CONFIGS[variants[gameId]!];
  if (!cfg) throw new Error('unknown multiplier variant');
  const row = weighted(cfg.kDist, tape), deck = [...DECK_CODES], out: Array<{ card: string; multiplier: number }> = [];
  for (let i = 0; i < row.k; i++) {
    const at = i + tape.int(52 - i); [deck[i], deck[at]] = [deck[at]!, deck[i]!];
    out.push({ card: deck[i]!, multiplier: weighted(row.multipliers, tape).value });
  }
  tape.finish(); return out;
}
const sum = (cs: readonly string[]) => cs.reduce((s, c) => s + baccaratValue(c), 0) % 10;
export function replayBaccaratCards(cards: readonly string[]) {
  if (cards.length < 4) throw new Error('incomplete baccarat hand');
  const player = [cards[0]!, cards[2]!], banker = [cards[1]!, cards[3]!];
  const initialP = sum(player), initialB = sum(banker), natural = initialP >= 8 || initialB >= 8;
  let at = 4;
  if (!natural) {
    const third = initialP <= 5 ? baccaratValue(cards[at] ?? '') : -1;
    if (initialP <= 5) { if (!cards[at]) throw new Error('missing Player third card'); player.push(cards[at++]!); }
    const draw = third < 0 ? initialB <= 5 : initialB <= 2 || initialB === 3 && third !== 8 || initialB === 4 && third >= 2 && third <= 7 || initialB === 5 && third >= 4 && third <= 7 || initialB === 6 && [6, 7].includes(third);
    if (draw) { if (!cards[at]) throw new Error('missing Banker third card'); banker.push(cards[at++]!); }
  }
  if (at !== cards.length) throw new Error('extra cards after baccarat tableau');
  const playerTotal = sum(player), bankerTotal = sum(banker);
  return { player, banker, playerTotal, bankerTotal, winner: playerTotal > bankerTotal ? 'player' : playerTotal < bankerTotal ? 'banker' : 'tie', natural: initialP >= 8 && initialB >= 8 ? 'both' : initialP >= 8 ? 'player' : initialB >= 8 ? 'banker' : null };
}

export function checkBaccaratPayout(proof: RoundProof, cards: RoundCards | null, context: PayoutContext & { shoeStepIndex?: number; shoeSteps?: number }): OutcomeCheck {
  const errors: string[] = [], unproven: string[] = [];
  const detail = (proof.outcome as { detail?: Record<string, unknown> } | null)?.detail;
  const meta = detail?.payoutProof as Record<string, unknown> | undefined;
  if (!meta || meta.version !== 'baccarat/payout-v1') return { checked: false, summary: 'historical baccarat card proof', errors: [], unproven: ['this historical record does not contain versioned baccarat payouts'] };
  if (!cards || cards.length !== 1) return { checked: false, summary: null, errors: ['baccarat payout needs exactly one verified hand'] };
  const own = context.baccaratBets;
  if (!own) return { checked: false, summary: null, errors: [], unproven: ['the player-owned accepted baccarat board is not given'] };
  try {
    const h = replayBaccaratCards(cards[0]!);
    const cfg = variants[proof.gameId] ? MULTIPLIER_CONFIGS[variants[proof.gameId]!] : null;
    let strikes: Array<{ card: string; multiplier: number }> = [];
    if (cfg) {
      const drawing = authorizedSteps(proof, context, ['baccarat-free', 'baccarat-deal']);
      if (drawing.length !== context.shoeSteps || !integer(context.shoeStepIndex, 0, drawing.length - 1)) throw new Error('the strike steps do not match the committed hand slices');
      if (context.baccaratSeedId !== proof.seedId || !integer(context.baccaratNonce)) throw new UnprovenPayoutError('the accepted multiplier hand has no player-owned pair/nonce receipt');
      requireEqual(errors, 'accepted multiplier hand nonce', drawing[context.shoeStepIndex]!.nonce, context.baccaratNonce);
      const all = drawing.map((s) => replayBaccaratStrike(proof.gameId, new PayoutTape(s)));
      strikes = all[context.shoeStepIndex]!;
      requireEqual(errors, 'baccarat strikes', detail!.strikes, strikes);
    } else if (proof.steps.some((s) => s.status === 'ok' && s.draws.length > 0)) throw new Error('classic baccarat has no round-stream draw');
    const product = (cs: readonly string[]) => cs.reduce((m, card) => m * (strikes.find((s) => s.card === card)?.multiplier ?? 1), 1);
    const products = { player: product(h.player), banker: product(h.banker), tie: product(cards[0]!), playerPair: product(h.player.slice(0, 2)), bankerPair: product(h.banker.slice(0, 2)) };
    const pair = (cs: readonly string[]) => cs[0]!.slice(0, -1) === cs[1]!.slice(0, -1);
    const suited = Number(h.player[0] === h.player[1]) + Number(h.banker[0] === h.banker[1]);
    const table = Number(detail!.table);
    if (!integer(table, 1, cfg ? 1 : 12)) throw new Error('invalid baccarat table');
    const order = cfg ? ['player', 'banker', 'tie', 'player_pair', 'banker_pair'] : ['player', 'banker', 'tie', 'player_pair', 'banker_pair', 'perfect_pair', 'either_pair', 'player_bonus', 'banker_bonus', ...(table > 6 ? ['super6'] : [])];
    const bets: Record<string, number> = {};
    for (const [spot, stake] of Object.entries(own)) { if (!order.includes(spot) || !integer(stake, 1)) throw new Error('invalid player-owned baccarat stake'); bets[spot] = stake; }
    const payouts: Array<{ spot: string; stake: number; payout: number; outcome: string; multiplier: number; fee: number; capped?: true }> = [];
    const odds = (stake: number, num: number, den = 1) => stake + Number(BigInt(stake) * BigInt(num) / BigInt(den));
    const bonus = (side: 'player' | 'banker', stake: number): number => {
      if (h.winner === 'tie') return h.natural === 'both' ? stake : 0;
      if (h.winner !== side) return 0;
      if (h.natural === side || h.natural === 'both') return 2 * stake;
      const margin = Math.abs(h.playerTotal - h.bankerTotal), pay = [0, 0, 0, 0, 1, 2, 4, 6, 10, 30][margin]!;
      return pay ? odds(stake, pay) : 0;
    };
    for (const spot of order) {
      const stake = bets[spot]; if (stake === undefined) continue;
      let payout = 0, m = 1;
      if (cfg) {
        if (spot === 'player' || spot === 'banker') { if (h.winner === 'tie') payout = stake; else if (h.winner === spot) { m = products[spot]; payout = odds(stake, m * 100 - (spot === 'banker' ? cfg.bankerCommission : 0), 100); } }
        else if (spot === 'tie' && h.winner === 'tie') { m = products.tie; payout = odds(stake, cfg.tieOdds * m, 100); }
        else if (spot.endsWith('_pair') && pair(spot === 'player_pair' ? h.player : h.banker)) { m = spot === 'player_pair' ? products.playerPair : products.bankerPair; payout = odds(stake, cfg.pairOdds * m, 100); }
      } else if (spot === 'player' || spot === 'banker') payout = h.winner === 'tie' ? stake : h.winner !== spot ? 0 : spot === 'player' ? 2 * stake : table <= 6 ? odds(stake, 95, 100) : h.bankerTotal === 6 ? odds(stake, 1, 2) : 2 * stake;
      else if (spot === 'tie') payout = h.winner === 'tie' ? 9 * stake : 0;
      else if (spot === 'player_pair' || spot === 'banker_pair') payout = pair(spot === 'player_pair' ? h.player : h.banker) ? 12 * stake : 0;
      else if (spot === 'either_pair') payout = pair(h.player) || pair(h.banker) ? 6 * stake : 0;
      else if (spot === 'perfect_pair') payout = suited === 2 ? 201 * stake : suited === 1 ? 26 * stake : 0;
      else if (spot === 'super6') payout = h.winner === 'banker' && h.bankerTotal === 6 ? 16 * stake : 0;
      else payout = bonus(spot === 'player_bonus' ? 'player' : 'banker', stake);
      const push = payout === stake && (spot === 'player' || spot === 'banker' || spot.endsWith('_bonus'));
      const fee = cfg ? Number((BigInt(stake) * BigInt(cfg.feePercent) + 99n) / 100n) : 0;
      payouts.push({ spot, stake, payout, outcome: payout ? push ? 'push' : 'win' : 'lose', multiplier: m, fee });
    }
    const win = payouts.reduce((sum, p) => sum + Math.max(0, p.payout - p.stake), 0);
    if (cfg && win > cfg.winCap) for (const p of payouts) if (p.payout > p.stake) { p.payout = p.stake + Number(BigInt(p.payout - p.stake) * BigInt(cfg.winCap) / BigInt(win)); p.capped = true; }
    const staked = payouts.reduce((sum, p) => sum + p.stake, 0), fee = payouts.reduce((sum, p) => sum + p.fee, 0), returned = payouts.reduce((sum, p) => sum + p.payout, 0);
    requireEqual(errors, 'accepted baccarat bets', meta.bets, bets);
    requireEqual(errors, 'baccarat payouts', meta.payouts, payouts);
    requireEqual(errors, 'baccarat products', meta.products, products);
    requireEqual(errors, 'baccarat stake', meta.staked, staked); requireEqual(errors, 'baccarat fee', meta.fee, fee); requireEqual(errors, 'baccarat returned', meta.returned, returned);
    requireEqual(errors, 'baccarat fee detail', detail!.fee, fee);
    requireEqual(errors, 'winning baccarat product', detail!.multiplier, h.winner === 'player' ? products.player : h.winner === 'banker' ? products.banker : products.tie);
    return { checked: true, summary: `baccarat payouts ${returned} on ${staked + fee} cents`, errors, unproven };
  } catch (e) { if (e instanceof UnprovenPayoutError) return { checked: false, summary: null, errors: [], unproven: [e.message] }; return { checked: true, summary: 'invalid baccarat payout replay', errors: [e instanceof Error ? e.message : String(e)] }; }
}
