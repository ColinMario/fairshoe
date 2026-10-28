/**
 * Exact, order-independent return bounds for the card family. Input is only the 52 identity counts still unseen:
 * hidden burns remain in it. Six-draw masses are integer Numbers <= 416! / 410! < 2^53; payouts and comparisons
 * use reduced BigInt fractions. Multiplier Tie includes all four to six cards, with repeated identities counted.
 */
import { DECK_CODES } from './shoe.ts';
import { MULTIPLIER_CONFIGS, type GuardMultiplierConfig } from './guard-weights.ts';
import { addFraction, choose, compareFraction, falling, fraction, multiplyFraction, type Fraction } from './guard-math.ts';
export type { Fraction } from './guard-math.ts';
export * from './guard-math.ts';
export * from './guard-weights.ts';

export const GUARD_CAP: Fraction = Object.freeze({ num: 995n, den: 1000n });
export type GuardVariant = 'classic' | 'no-commission' | GuardMultiplierConfig['id'];
export type GuardRates = Record<string, Fraction>;
const VALUES = Array.from({ length: 52 }, (_, i) => i % 13 < 9 ? i % 13 + 1 : 0);
const INDEX = new Map(DECK_CODES.map((c, i) => [c, i]));
const ZERO = fraction(0n);
const ONE = fraction(1n);

export function fullUnseen(): number[] { return Array<number>(52).fill(8); }
export function observeCard(unseen: number[], card: string): void {
  const i = INDEX.get(card);
  if (i === undefined || !Number.isSafeInteger(unseen[i]) || unseen[i]! <= 0) throw new Error('invalid observed card');
  unseen[i]!--;
}
function validate(unseen: readonly number[], minimum: number): number {
  if (unseen.length !== 52 || unseen.some((n) => !Number.isInteger(n) || n < 0 || n > 8)) throw new Error('invalid unseen composition');
  const n = unseen.reduce((a, b) => a + b, 0);
  if (n < minimum) throw new Error('not enough unseen cards');
  return n;
}
const fromNumber = (n: number, d = 1): Fraction => {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d)) throw new Error('unsafe exact mass');
  return fraction(BigInt(n), BigInt(d));
};
const scale = (a: Fraction, n: number, d = 1): Fraction => multiplyFraction(a, fromNumber(n, d));
const POWERS = Array.from({ length: 10 }, (_, i) => 7 ** i);
const patternKey = (cards: readonly number[]) => [...cards].sort((a, b) => b - a).join('');
function addMass<K>(map: Map<K, number>, key: K, mass: number): void { map.set(key, (map.get(key) ?? 0) + mass); }

/** E[product] for identity multiplicities, with exact subset and independent strike-value probabilities. */
const productCache = new Map<string, Fraction>();
export function guardProductMean(variant: GuardMultiplierConfig['id'], pattern: readonly number[]): Fraction {
  if (pattern.length === 0 || pattern.some((n) => !Number.isInteger(n) || n < 1) || pattern.reduce((a, b) => a + b, 0) > 6) throw new Error('invalid identity pattern');
  const key = variant + ':' + patternKey(pattern);
  const cached = productCache.get(key);
  if (cached) return cached;
  const cfg = MULTIPLIER_CONFIGS[variant];
  const total = cfg.kDist.reduce((a, b) => a + b.weight, 0);
  let result = ZERO;
  for (const row of cfg.kDist) {
    const weights = row.multipliers.reduce((a, b) => a + b.weight, 0);
    const moments = pattern.map((power) => fromNumber(row.multipliers.reduce((a, m) => a + m.weight * m.value ** power, 0), weights));
    let mean = ZERO;
    for (let mask = 0; mask < 1 << pattern.length; mask++) {
      let hits = 0, product = ONE;
      for (let i = 0; i < pattern.length; i++) if (mask & (1 << i)) { hits++; product = multiplyFraction(product, moments[i]!); }
      const ways = choose(52 - pattern.length, row.k - hits);
      if (ways > 0) mean = addFraction(mean, scale(product, ways, choose(52, row.k)));
    }
    result = addFraction(result, scale(mean, row.weight, total));
  }
  productCache.set(key, result);
  return result;
}

/** Identity patterns are base-seven histograms: digit i counts identities occurring i+1 times.
 * At most six cards are selected, so joining two disjoint identity groups is exact integer addition
 * with no carry. This replaces sorting/allocating pattern strings in the inner combinatorial loops. */
const identityPattern = (key: number): number[] => {
  const result: number[] = [];
  for (let power = 1; key > 0; power++, key = Math.floor(key / 7))
    for (let count = key % 7; count > 0; count--) result.push(power);
  return result;
};
/** Number of unordered card selections for every identity pattern in one baccarat value class. */
function identitySelections(ids: readonly number[]): Map<number, number>[] {
  let dp = Array.from({ length: 7 }, () => new Map<number, number>());
  dp[0]!.set(0, 1);
  for (const copies of ids) {
    const next = Array.from({ length: 7 }, () => new Map<number, number>());
    for (let used = 0; used <= 6; used++) for (const [pattern, ways] of dp[used]!) {
      for (let take = 0; take <= Math.min(copies, 6 - used); take++) {
        const key = pattern + (take ? POWERS[take - 1]! : 0);
        addMass(next[used + take]!, key, ways * choose(copies, take));
      }
    }
    dp = next;
  }
  return dp;
}

interface BaccaratComposition {
  classic: GuardRates;
  noCommission: GuardRates;
  multiplier?: (variant: GuardMultiplierConfig['id']) => GuardRates;
}
// Different rules use the same exact physical-card masses. Keep only a small bounded set, never future order.
const compositionCache = new Map<string, BaccaratComposition>();
function keepComposition(key: string, value: BaccaratComposition): void {
  compositionCache.set(key, value);
  if (compositionCache.size > 8) compositionCache.delete(compositionCache.keys().next().value!);
}
// Do not expose cached mutable objects through this public API.
const copyRates = (rates: GuardRates): GuardRates => Object.fromEntries(Object.entries(rates).map(([spot, r]) => [spot, { ...r }]));

/** Exact return of each classic/multiplier baccarat spot before cent flooring and the win cap. */
export function baccaratGuardRates(unseen: readonly number[], variant: GuardVariant = 'classic'): GuardRates {
  const n = validate(unseen, 6);
  const cacheKey = unseen.join(','), cached = compositionCache.get(cacheKey);
  const multiplied = variant !== 'classic' && variant !== 'no-commission';
  if (cached) {
    if (!multiplied) return copyRates(variant === 'classic' ? cached.classic : cached.noCommission);
    if (cached.multiplier) return cached.multiplier(variant);
  }
  const counts = Array<number>(10).fill(0);
  const ranks = Array<number>(13).fill(0);
  const ids = Array.from({ length: 10 }, () => [] as number[]);
  unseen.forEach((c, i) => { counts[VALUES[i]!]! += c; ranks[i % 13]! += c; ids[VALUES[i]!]!.push(c); });
  const original = counts.slice();
  const denominator = falling(n, 6);
  const out = new Float64Array(400);
  const main = [new Map<number, number>(), new Map<number, number>()];
  const ties = new Map<number, number>();
  let playerKey = 0, bankerKey = 0;
  const draw = (bt: number, third: number) => third < 0 ? bt <= 5 : bt <= 2 || bt === 3 && third !== 8 || bt === 4 && third >= 2 && third <= 7 || bt === 5 && third >= 4 && third <= 7 || bt === 6 && (third === 6 || third === 7);
  const emit = (mass: number, pt: number, bt: number, natural: number, length: number): void => {
    // Embed shorter hands into a common six-draw sample space, without actually observing those unused cards.
    mass *= falling(n - length, 6 - length);
    out[(pt * 10 + bt) * 4 + natural]! += mass;
    if (multiplied) {
      if (pt > bt) addMass(main[0]!, playerKey, mass);
      else if (bt > pt) addMass(main[1]!, bankerKey, mass);
      else addMass(ties, playerKey + bankerKey, mass);
    }
  };
  // The first two cards of each side are unordered (two permutations when the values differ).
  for (let a = 0; a < 10; a++) {
    if (!counts[a]) continue;
    const w1 = counts[a]!--;
    for (let c = a; c < 10; c++) {
      if (!counts[c]) continue;
      const w2 = w1 * counts[c]!-- * (a === c ? 1 : 2);
      const initialPlayerKey = POWERS[a]! + POWERS[c]!;
      playerKey = initialPlayerKey;
      const pt = (a + c) % 10;
      for (let x = 0; x < 10; x++) {
        if (!counts[x]) continue;
        const w3 = w2 * counts[x]!--;
        for (let y = x; y < 10; y++) {
          if (!counts[y]) continue;
          const w4 = w3 * counts[y]!-- * (x === y ? 1 : 2);
          const initialBankerKey = POWERS[x]! + POWERS[y]!;
          bankerKey = initialBankerKey;
          const bt = (x + y) % 10;
          if (pt >= 8 || bt >= 8) emit(w4, pt, bt, (pt >= 8 ? 1 : 0) + (bt >= 8 ? 2 : 0), 4);
          else if (pt <= 5) {
            for (let z = 0; z < 10; z++) {
              if (!counts[z]) continue;
              const w5 = w4 * counts[z]!--;
              playerKey = initialPlayerKey + POWERS[z]!;
              if (draw(bt, z)) {
                for (let t = 0; t < 10; t++) if (counts[t]) { bankerKey = initialBankerKey + POWERS[t]!; emit(w5 * counts[t]!, (pt + z) % 10, (bt + t) % 10, 0, 6); }
                bankerKey = initialBankerKey;
              } else emit(w5, (pt + z) % 10, bt, 0, 5);
              counts[z]!++;
            }
            playerKey = initialPlayerKey;
          } else if (draw(bt, -1)) {
            for (let t = 0; t < 10; t++) if (counts[t]) { bankerKey = initialBankerKey + POWERS[t]!; emit(w4 * counts[t]!, pt, (bt + t) % 10, 0, 5); }
            bankerKey = initialBankerKey;
          } else emit(w4, pt, bt, 0, 4);
          counts[y]!++;
        }
        counts[x]!++;
      }
      counts[c]!++;
    }
    counts[a]!++;
  }
  if (out.reduce((a, b) => a + b, 0) !== denominator) throw new Error('baccarat mass does not sum to the sample space');
  let player = 0, banker = 0, tie = 0, six = 0;
  let playerBonus = 0n, bankerBonus = 0n;
  const bonus = [0, 0, 0, 0, 2, 3, 5, 7, 11, 31];
  for (let pt = 0; pt < 10; pt++) for (let bt = 0; bt < 10; bt++) for (let nat = 0; nat < 4; nat++) {
    const mass = out[(pt * 10 + bt) * 4 + nat]!;
    if (pt > bt) {
      player += mass;
      const pay = nat & 1 ? 2 : nat === 0 ? bonus[pt - bt]! : 0;
      playerBonus += BigInt(mass) * BigInt(pay);
    } else if (bt > pt) {
      banker += mass; if (bt === 6) six += mass;
      const pay = nat & 2 ? 2 : nat === 0 ? bonus[bt - pt]! : 0;
      bankerBonus += BigInt(mass) * BigInt(pay);
    } else { tie += mass; if (nat === 3) { playerBonus += BigInt(mass); bankerBonus += BigInt(mass); } }
  }
  const pairCount = ranks.reduce((a, c) => a + falling(c, 2), 0);
  const suitedCount = unseen.reduce((a, c) => a + falling(c, 2), 0);
  const both = (list: readonly number[]) => {
    let s2 = 0, s22 = 0, s4 = 0;
    for (const c of list) { const f = falling(c, 2); s2 += f; s22 += f * f; s4 += falling(c, 4); }
    return s2 * s2 - s22 + s4;
  };
  const D = BigInt(denominator), P = BigInt(player), B = BigInt(banker), T = BigInt(tie), S = BigInt(six);
  const N2 = BigInt(falling(n, 2)), N4 = BigInt(falling(n, 4));
  {
    const pair = fraction(BigInt(pairCount) * 12n, N2);
    const classic: GuardRates = {
      player: fraction(2n * P + T, D),
      banker: fraction(195n * B + 100n * T, 100n * D),
      tie: fraction(9n * T, D), super6: fraction(16n * S, D),
      player_bonus: fraction(playerBonus, D), banker_bonus: fraction(bankerBonus, D),
      player_pair: pair, banker_pair: pair,
      either_pair: addFraction(fraction(12n * BigInt(pairCount), N2), fraction(-6n * BigInt(both(ranks)), N4)),
      perfect_pair: addFraction(fraction(52n * BigInt(suitedCount), N2), fraction(149n * BigInt(both(unseen)), N4)),
    };
    const context: BaccaratComposition = { classic, noCommission: { ...classic, banker: fraction(4n * B - S + 2n * T, 2n * D) } };
    keepComposition(cacheKey, context);
    if (!multiplied) return copyRates(variant === 'classic' ? context.classic : context.noCommission);
  }
  const selections = ids.map(identitySelections);
  // The value-sequence mass includes every identity selection equally. Divide its number of unordered selections
  // first (an exact integer division), then multiply each pattern's count. This cancels conditional denominators.
  const patternMasses = (values: Map<number, number>): Map<number, number> => {
    const result = new Map<number, number>();
    for (const [key, mass] of values) {
      const histogram = Array<number>(10).fill(0);
      let rest = key;
      for (let v = 0; rest > 0; v++) { histogram[v] = rest % 7; rest = Math.floor(rest / 7); }
      let denominator = 1;
      let patterns = new Map<number, number>([[0, 1]]);
      histogram.forEach((c, value) => {
        if (!c) return;
        denominator *= choose(original[value]!, c);
        const next = new Map<number, number>();
        for (const [a, aw] of patterns) for (const [b, bw] of selections[value]![c]!) addMass(next, a + b, aw * bw);
        patterns = next;
      });
      const weight = mass / denominator;
      if (!Number.isSafeInteger(weight)) throw new Error('noninteger identity mass');
      for (const [key, ways] of patterns) addMass(result, key, weight * ways);
    }
    return result;
  };
  const playerMasses = patternMasses(main[0]!), bankerMasses = patternMasses(main[1]!), tieMasses = patternMasses(ties);
  const multiplier = (variant: GuardMultiplierConfig['id']): GuardRates => {
    const cfg = MULTIPLIER_CONFIGS[variant];
    const expected = (masses: Map<number, number>, denominator: bigint): Fraction => {
      let value = ZERO;
      for (const [pattern, mass] of masses) value = addFraction(value, multiplyFraction(fraction(BigInt(mass), denominator), guardProductMean(variant, identityPattern(pattern))));
      return value;
    };
    const fee = (value: Fraction): Fraction => scale(value, 100, 100 + cfg.feePercent);
    const pairMean = expected(new Map([[7, suitedCount], [2, pairCount - suitedCount]]), N2);
    const pair = fee(addFraction(fraction(BigInt(pairCount), N2), scale(pairMean, cfg.pairOdds, 100)));
    return {
      player: fee(addFraction(fraction(P + T, D), expected(playerMasses, D))),
      banker: fee(addFraction(fraction((100n - BigInt(cfg.bankerCommission)) * B + 100n * T, 100n * D), expected(bankerMasses, D))),
      tie: fee(addFraction(fraction(T, D), scale(expected(tieMasses, D), cfg.tieOdds, 100))),
      player_pair: pair, banker_pair: pair,
    };
  };
  compositionCache.get(cacheKey)!.multiplier = multiplier;
  return multiplier(variant);
}

export function duelGuardRates(unseen: readonly number[], highCard = false): GuardRates {
  const n = validate(unseen, 2), ranks = Array<number>(13).fill(0);
  unseen.forEach((c, i) => { ranks[i % 13]! += c; });
  const D = BigInt(falling(n, 2));
  const ties = BigInt(ranks.reduce((a, c) => a + falling(c, 2), 0));
  const suited = BigInt(unseen.reduce((a, c) => a + falling(c, 2), 0));
  const side = fraction(2n * D - ties, 2n * D);
  return highCard ? { home: side, away: side, draw: fraction(12n * ties, D) } : { dragon: side, tiger: side, tie: fraction(12n * ties, D), suited_tie: fraction(51n * suited, D) };
}

export function guardTriggered(rates: GuardRates, main: readonly string[]): string | null {
  return main.find((spot) => rates[spot] && compareFraction(rates[spot]!, GUARD_CAP) > 0) ?? null;
}

/** Trim above-cap side bets in published order against the coverage from below-cap bets. Costs include the fee. */
export function guardBoard(bets: Readonly<Record<string, number>>, rates: GuardRates, order: readonly string[], options: { main?: readonly string[]; sideRatio?: Fraction; sideRatioSpots?: readonly string[]; minimum?: number } = {}): { bets: Record<string, number>; trimmed: Array<{ spot: string; requested: number; allowed: number }>; rejected: boolean } {
  const out: Record<string, number> = { ...bets };
  let cover = ZERO;
  const mainTotal = (options.main ?? []).reduce((s, key) => s + (bets[key] ?? 0), 0);
  const delta = (r: Fraction) => addFraction(GUARD_CAP, fraction(-r.num, r.den));
  for (const [spot, amount] of Object.entries(out)) {
    if (!Number.isSafeInteger(amount) || amount < 0 || !rates[spot]) throw new Error('invalid guard board');
    // All spots in one game have the same percentage fee; cancelling it makes the pre-rounding bound conservative.
    if (options.sideRatio && (options.sideRatioSpots ? options.sideRatioSpots.includes(spot) : !options.main?.includes(spot))) {
      const max = Number(BigInt(mainTotal) * options.sideRatio.num / options.sideRatio.den);
      out[spot] = Math.min(amount, max);
    }
    if (out[spot]! < (options.minimum ?? 0)) out[spot] = 0;
  }
  for (const [spot, amount] of Object.entries(out)) if (compareFraction(rates[spot]!, GUARD_CAP) <= 0) cover = addFraction(cover, scale(delta(rates[spot]!), amount));
  for (const spot of order) {
    const amount = out[spot] ?? 0, rate = rates[spot];
    if (!amount || !rate || compareFraction(rate, GUARD_CAP) <= 0) continue;
    const excess = fraction(-delta(rate).num, delta(rate).den);
    const maximum = cover.num <= 0n ? 0 : Number(cover.num * excess.den / (cover.den * excess.num));
    const allowed = Math.min(amount, maximum);
    out[spot] = allowed < (options.minimum ?? 0) ? 0 : allowed;
    cover = addFraction(cover, scale(excess, -out[spot]!));
  }
  const trimmed = Object.entries(bets).filter(([s, v]) => (out[s] ?? 0) < v).map(([spot, requested]) => ({ spot, requested, allowed: out[spot] ?? 0 }));
  for (const key of Object.keys(out)) if (!out[key]) delete out[key];
  return { bets: out, trimmed, rejected: Object.keys(bets).length > 0 && Object.keys(out).length === 0 };
}

export function cardGuardRates(gameId: string, table: number, unseen: readonly number[]): GuardRates {
  if (gameId === 'dragon-tiger' || gameId === 'card-duel') return duelGuardRates(unseen, gameId === 'card-duel');
  const variant: GuardVariant = gameId === 'baccarat' ? table > 6 ? 'no-commission' : 'classic' : gameId === 'blitz-baccarat' ? 'multiplier' : gameId === 'blitz-baccarat-max' ? 'max' : gameId === 'jade-baccarat' ? 'jade' : gameId === 'gold-baccarat' ? 'gold' : (() => { throw new Error('unknown guarded game'); })();
  return baccaratGuardRates(unseen, variant);
}

/** Recompute every wager boundary from visible cards only. Hidden burn cards stay exchangeable with the remainder. */
export function guardShoeBoundaries(gameId: string, table: number, dealing: readonly string[], burn: { cards: number; shown: string | null } | null, rounds: readonly { from: number; to: number }[]): Array<{ before: number; spot: string | null; rates: GuardRates }> {
  const unseen = fullUnseen();
  if (burn?.shown !== null && burn?.shown !== undefined) observeCard(unseen, burn.shown);
  const boundaries: Array<{ before: number; spot: string | null; rates: GuardRates }> = [];
  const main = gameId === 'dragon-tiger' ? ['dragon', 'tiger'] : gameId === 'card-duel' ? ['home', 'away'] : ['player', 'banker'];
  let before = burn?.cards ?? 0;
  for (let i = 0; i <= rounds.length; i++) {
    const rates = cardGuardRates(gameId, table, unseen);
    boundaries.push({ before, spot: guardTriggered(rates, main), rates });
    if (i === rounds.length) break;
    const round = rounds[i]!;
    for (let at = round.from; at < round.to; at++) observeCard(unseen, dealing[at]!);
    before = round.to;
  }
  return boundaries;
}

export interface GuardDecision {
  /** Independently tracked round-stream nonce and pair before the accepted multiplier hand. */
  startNonce?: number;
  seedId?: string;
  /** Position before the requested hand, taken from the player's view before sending its request. */
  before: number;
  requested: Record<string, number>;
  /** Actual accepted amounts, or null for a guard refusal. */
  granted: Record<string, number> | null;
  /** A lost response is an availability gap, not proof that the server refused this board. */
  unanswered?: true;
  /** Transport/application refusal code kept by the client. Only guard_limit alleges a guard rejection. */
  refusal?: string;
}
/** Check a server's trim/refusal against the original board kept by the player. */
export function guardDecisionErrors(gameId: string, rates: GuardRates, decision: GuardDecision): string[] {
  const duel = gameId === 'dragon-tiger' || gameId === 'card-duel';
  const order = guardSpotOrder(gameId);
  const minimum = gameId === 'card-duel' ? 20 : gameId === 'dragon-tiger' ? 50 : 100;
  const result = guardBoard(decision.requested, rates, order, duel ? { minimum } : { minimum, main: ['player', 'banker'], sideRatio: { num: 1n, den: decision.before >= 312 ? 4n : 2n }, sideRatioSpots: gameId === 'baccarat' ? ['player_bonus', 'banker_bonus', 'perfect_pair', 'super6'] : [] });
  if (decision.granted === null) return result.rejected ? [] : ['a board with legal guard coverage was refused'];
  if (result.rejected) return ['an uncovered board was accepted'];
  const same = [...new Set([...Object.keys(decision.granted), ...Object.keys(result.bets)])].every((spot) => (decision.granted![spot] ?? 0) === (result.bets[spot] ?? 0));
  return same ? [] : ['the granted board is not the deterministic guard trim of the requested board'];
}

/** Published trim priority, independent of object-property enumeration or which bets happen to be present. */
export function guardSpotOrder(gameId: string): readonly string[] {
  if (gameId === 'dragon-tiger') return ['dragon', 'tiger', 'tie', 'suited_tie'];
  if (gameId === 'card-duel') return ['home', 'away', 'draw'];
  if (gameId === 'baccarat') return ['player', 'banker', 'tie', 'player_pair', 'banker_pair', 'perfect_pair', 'either_pair', 'player_bonus', 'banker_bonus', 'super6'];
  return ['player', 'banker', 'tie', 'player_pair', 'banker_pair'];
}
