/**
 * Game mappings (SPEC.md section 9): what the draws and cards of a round mean, recomputed and compared with the
 * outcome a proof states. A mapping fixes the whole draw plan of a round: which steps draw and exactly what they
 * draw. Anything else (a draw before or after the plan, a second drawing step, a draw outside a round) is an error:
 * the server writes the draws down itself, and with extra draws it could pick the value the game reads. A finished
 * round of a mapped game must state its outcome (`outcome.detail`): a proof that leaves it out is an error, never an
 * unchecked round.
 *
 * The card games deal by their published rules, part of v1: baccarat by the punto banco tableau (a hand takes four to
 * six cards, the third-card rules decide), Dragon Tiger and Card Duel one card per side. The cards, the totals and the
 * winner are recomputed from the round's own slice; every hand a shoe dealt (free hands too) must have the length
 * these rules give (handRule, checked by verifyShoe).
 *
 * The multiplier variants of baccarat get their tableau compared (an error when it differs), but their outcome is not
 * checked: the strike draws and their weight tables are not mapped yet. For every other game the draws (and cards)
 * are verified, the outcome is not (OutcomeCheck.checked false), so a verifier must not call that outcome checked.
 */
import type { RoundProof, StepProof } from './records.ts';
import { baccaratValue, type CardCode } from './shoe.ts';

export interface OutcomeCheck {
  /**
   * True when this game has a full mapping and the outcome was recomputed (errors then lists every disagreement).
   * False for a game without one, for a void round and for steps outside a round; errors may still list a
   * disagreement of the part that is mapped (the tableau of a multiplier variant, the draw plan of a void round).
   */
  checked: boolean;
  /** What was compared, for a reader ("pocket 26", "crash 1.79x", "player 8D 4S (2), banker ..."). */
  summary: string | null;
  errors: string[];
}

/** Cards dealt to the round itself (dealing order), one list per slice of the round. */
export type RoundCards = readonly (readonly CardCode[])[];

interface Detail {
  [key: string]: unknown;
}

const TWO_32 = 0x1_0000_0000;

/** High Flyer: the fly-away point in hundredths for a draw r of int(2^32): floor(97 * 2^32 / (2^32 - r)), 1.00x to 20,000x. */
export function crashPoint(r: number): number {
  const q = (97n * BigInt(TWO_32)) / (BigInt(TWO_32) - BigInt(r));
  return Number(q < 100n ? 100n : q > 2_000_000n ? 2_000_000n : q);
}

function detailOf(proof: RoundProof): Detail | null {
  const o = proof.outcome as { detail?: unknown } | null;
  return o && typeof o === 'object' && o.detail && typeof o.detail === 'object' && !Array.isArray(o.detail) ? (o.detail as Detail) : null;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Baccarat family: only plain baccarat is fully mapped (the variants also draw strikes from the round stream). */
const BACCARAT_FULL = new Set(['baccarat']);
const BACCARAT_VARIANTS = new Set(['blitz-baccarat', 'gold-baccarat', 'jade-baccarat', 'blitz-baccarat-max']);

interface DuelRules {
  /** The first side (dealt first), the second side. */
  sides: readonly [string, string];
  /** What the detail calls a tie. */
  tie: string;
  /** Rank of an ace: 1 (low) or 14 (high); J 11, Q 12, K 13, the others their number. */
  ace: 1 | 14;
}

const DUELS: Readonly<Record<string, DuelRules>> = {
  'dragon-tiger': { sides: ['dragon', 'tiger'], tie: 'tie', ace: 1 },
  'card-duel': { sides: ['home', 'away'], tie: 'draw', ace: 14 },
};

/** Games whose round deals from a committed shoe: their proof must hold the round's own slice. */
export const CARD_GAMES: readonly string[] = Object.freeze([...BACCARAT_FULL, ...BACCARAT_VARIANTS, ...Object.keys(DUELS)].sort());

// ------------------------------------------------------------------------------------------------ card rules

/** One hand of punto banco, recomputed from the dealing order. */
export interface BaccaratHand {
  player: CardCode[];
  banker: CardCode[];
  playerTotal: number;
  bankerTotal: number;
  winner: 'player' | 'banker' | 'tie';
  natural: 'player' | 'banker' | 'both' | null;
  /** Cards the hand took from the dealing order (4 to 6). */
  cards: number;
}

const handTotal = (cards: readonly CardCode[]): number => cards.reduce((t, c) => t + baccaratValue(c), 0) % 10;

/**
 * Does the Banker draw? `playerThird` is the baccarat value of the Player's third card, null when the Player stood.
 * Player stood: 0 to 5. Player drew: 0 to 2 always; 3 unless 8; 4 on 2 to 7; 5 on 4 to 7; 6 on 6 or 7; 7 never.
 */
function bankerDraws(total: number, playerThird: number | null): boolean {
  if (playerThird === null) return total <= 5;
  if (total <= 2) return true;
  if (total === 3) return playerThird !== 8;
  if (total === 4) return playerThird >= 2 && playerThird <= 7;
  if (total === 5) return playerThird >= 4 && playerThird <= 7;
  if (total === 6) return playerThird === 6 || playerThird === 7;
  return false;
}

/**
 * The punto banco tableau on the dealing order from a hand's first card: P1, B1, P2, B2; no more cards when either
 * hand has 8 or 9 (a natural); else the Player draws on 0 to 5, then the Banker by bankerDraws. Null when `cards`
 * runs out before the hand is complete.
 */
export function baccaratHand(cards: readonly CardCode[]): BaccaratHand | null {
  if (cards.length < 4) return null;
  const player = [cards[0]!, cards[2]!];
  const banker = [cards[1]!, cards[3]!];
  let next = 4;
  const p2 = handTotal(player);
  const b2 = handTotal(banker);
  const pNat = p2 >= 8;
  const bNat = b2 >= 8;
  if (!pNat && !bNat) {
    let third: number | null = null;
    if (p2 <= 5) {
      const c = cards[next++];
      if (c === undefined) return null;
      player.push(c);
      third = baccaratValue(c);
    }
    if (bankerDraws(b2, third)) {
      const c = cards[next++];
      if (c === undefined) return null;
      banker.push(c);
    }
  }
  const playerTotal = handTotal(player);
  const bankerTotal = handTotal(banker);
  return {
    player,
    banker,
    playerTotal,
    bankerTotal,
    winner: playerTotal > bankerTotal ? 'player' : bankerTotal > playerTotal ? 'banker' : 'tie',
    natural: pNat && bNat ? 'both' : pNat ? 'player' : bNat ? 'banker' : null,
    cards: next,
  };
}

/** Rank of a card in a duel game (ace low or high). */
function duelRank(code: CardCode, ace: 1 | 14): number {
  const r = code.slice(0, -1);
  return r === 'A' ? ace : r === 'J' ? 11 : r === 'Q' ? 12 : r === 'K' ? 13 : Number(r);
}

/**
 * The fixed hand of a card game (section 9): how many cards one hand takes from the dealing order at `from` (null
 * when the order runs out first). Null for a game whose hands depend on the player's decisions (blackjack) or that
 * has no shoe. verifyShoe checks every hand a shoe dealt against it, free hands included: a hand longer than the
 * rules would let the server skip cards.
 */
export function handRule(gameId: string): ((dealing: readonly CardCode[], from: number) => number | null) | null {
  if (BACCARAT_FULL.has(gameId) || BACCARAT_VARIANTS.has(gameId)) return (dealing, from) => baccaratHand(dealing.slice(from, from + 6))?.cards ?? null;
  if (DUELS[gameId]) return (dealing, from) => (from + 2 <= dealing.length ? 2 : null);
  return null;
}

// ------------------------------------------------------------------------------------------------ draw plans

/**
 * The draw plan of a round: exactly one applied step draws, and it draws exactly `plan` (the ranges n in order).
 * Discarded steps are not part of it (they are counted by verifyPair). `none`: a round may also have no drawing step
 * (a void round that never drew). Returns the draws (empty for none), or the errors.
 */
function planned(proof: RoundProof, plan: readonly number[], what: string, none = false): { v: number[] } | { errors: string[] } {
  const drawing = proof.steps.filter((s: StepProof) => s.status === 'ok' && Array.isArray(s.draws) && s.draws.length > 0);
  if (drawing.length === 0) return none ? { v: [] } : { errors: [`no draw: no ${what} in this round`] };
  if (drawing.length > 1) return { errors: [`${drawing.length} steps drew (nonces ${drawing.map((s) => s.nonce).join(', ')}): the ${what} is one step`] };
  const draws = drawing[0]!.draws;
  const want = plan.map((n) => (n === TWO_32 ? 'int(2^32)' : `int(${n})`)).join(', ');
  const got = draws.map((d) => (d.n === TWO_32 ? 'int(2^32)' : `int(${d.n})`)).join(', ');
  if (draws.length !== plan.length || draws.some((d, i) => d.n !== plan[i])) return { errors: [`the ${what} draws ${want}, the step drew ${got}`] };
  return { v: draws.map((d) => d.v) };
}

/** Pocket of a roulette wheel for the spin's int(n): 0 ... 36, and on the double-zero wheel 37 = "00". */
function pocketOf(n: number, v: number): number | '00' {
  return n === 38 && v === 37 ? '00' : v;
}

interface DrawMapping {
  /** The ranges of the one drawing step, in order. */
  plan: readonly number[];
  /** What the step is called in messages. */
  what: string;
  /** The outcome from the draws, against the proof's detail. */
  map: (v: readonly number[], detail: Detail) => { summary: string; errors: string[] };
}

const roulette = (n: number): DrawMapping => ({
  plan: [n],
  what: 'spin',
  map: (v, detail) => {
    const pocket = pocketOf(n, v[0]!);
    return { summary: `pocket ${pocket}`, errors: same(detail.pocket, pocket) ? [] : [`the draws give pocket ${pocket}, the proof says ${JSON.stringify(detail.pocket)}`] };
  },
});

/** Games whose outcome comes from the round stream alone. */
const DRAW_MAPPINGS: Readonly<Record<string, DrawMapping>> = {
  roulette: roulette(37),
  'american-roulette': roulette(38),
  'high-flyer': {
    // The takeoff is one step drawing exactly int(2^32); the detail states the multiplier (1.79 for 179 hundredths).
    plan: [TWO_32],
    what: 'flight',
    map: (v, detail) => {
      const crash = crashPoint(v[0]!);
      const stated = typeof detail.crash === 'number' ? Math.round(detail.crash * 100) : NaN;
      return { summary: `crash ${(crash / 100).toFixed(2)}x`, errors: stated === crash ? [] : [`the draw gives a crash at ${(crash / 100).toFixed(2)}x, the proof says ${JSON.stringify(detail.crash)}`] };
    },
  },
  'dice-baccarat': {
    // The roll is one step drawing exactly four int(6): Player die 1, die 2, Banker die 1, die 2.
    plan: [6, 6, 6, 6],
    what: 'roll',
    map: (v, detail) => {
      const dice = v.map((x) => x + 1);
      const want = { player: dice.slice(0, 2), banker: dice.slice(2, 4) };
      return { summary: `player ${want.player.join('+')}, banker ${want.banker.join('+')}`, errors: same(detail.dice, want) ? [] : [`the draws give ${JSON.stringify(want)}, the proof says ${JSON.stringify(detail.dice)}`] };
    },
  },
};

// ------------------------------------------------------------------------------------------------ card mappings

/** The round's own hand: exactly one slice (verifyRound passes the slices the shoes list under the round's id). */
function ownHand(cards: RoundCards | null): { dealt: readonly CardCode[] } | { errors: string[] } {
  if (!cards || cards.length === 0) return { errors: ['no shoe slice for the hand'] };
  if (cards.length > 1) return { errors: [`${cards.length} shoe slices for one hand`] };
  return { dealt: cards[0]! };
}

/** Baccarat family: the hand replayed by the tableau from the round's own slice; cards, totals and winner must agree. */
function baccaratOutcome(detail: Detail, cards: RoundCards | null): { summary: string; errors: string[] } {
  const hand = ownHand(cards);
  if ('errors' in hand) return { summary: 'no cards', errors: hand.errors };
  const played = baccaratHand(hand.dealt);
  const stated = `player ${Array.isArray(detail.player) ? detail.player.join(' ') : String(detail.player)}, banker ${Array.isArray(detail.banker) ? detail.banker.join(' ') : String(detail.banker)}`;
  if (!played) return { summary: stated, errors: [`the tableau takes more than ${hand.dealt.length} cards here, the shoe dealt ${hand.dealt.length} (${hand.dealt.join(' ')})`] };
  const summary = `player ${played.player.join(' ')} (${played.playerTotal}), banker ${played.banker.join(' ')} (${played.bankerTotal}), ${played.winner}`;
  const errors: string[] = [];
  if (played.cards !== hand.dealt.length) errors.push(`the tableau takes ${played.cards} cards here, the shoe dealt ${hand.dealt.length} (${hand.dealt.join(' ')})`);
  if (!same(detail.player, played.player) || !same(detail.banker, played.banker)) errors.push(`the tableau deals ${summary}, the proof says ${stated}`);
  if (detail.playerTotal !== played.playerTotal || detail.bankerTotal !== played.bankerTotal) errors.push(`the totals are ${played.playerTotal} and ${played.bankerTotal}, the proof says ${JSON.stringify(detail.playerTotal)} and ${JSON.stringify(detail.bankerTotal)}`);
  if (detail.winner !== played.winner) errors.push(`the winner is ${played.winner}, the proof says ${JSON.stringify(detail.winner)}`);
  if ('natural' in detail && !same(detail.natural, played.natural)) errors.push(`the natural is ${String(played.natural)}, the proof says ${JSON.stringify(detail.natural)}`);
  return { summary, errors };
}

/** Dragon Tiger and Card Duel: one card to the first side, then one to the second; the higher rank wins. */
function duelOutcome(rules: DuelRules, detail: Detail, cards: RoundCards | null): { summary: string; errors: string[] } {
  const hand = ownHand(cards);
  if ('errors' in hand) return { summary: 'no cards', errors: hand.errors };
  const [first, second] = rules.sides;
  const c = (detail.cards && typeof detail.cards === 'object' ? detail.cards : {}) as Record<string, unknown>;
  const stated = `${first} ${String(c[first])}, ${second} ${String(c[second])}`;
  if (hand.dealt.length !== 2) return { summary: stated, errors: [`a hand is 2 cards, the shoe dealt ${hand.dealt.length} (${hand.dealt.join(' ')})`] };
  const [a, b] = hand.dealt as [CardCode, CardCode];
  const ra = duelRank(a, rules.ace);
  const rb = duelRank(b, rules.ace);
  const winner = ra > rb ? first : rb > ra ? second : rules.tie;
  const suited = a === b;
  const summary = `${first} ${a}, ${second} ${b}, ${winner}`;
  const errors: string[] = [];
  if (!same([c[first], c[second]], hand.dealt)) errors.push(`the shoe dealt ${first} ${a}, ${second} ${b}, the proof says ${stated}`);
  if (detail.winner !== winner) errors.push(`the winner is ${winner}, the proof says ${JSON.stringify(detail.winner)}`);
  if (detail.suited !== suited) errors.push(`suited is ${String(suited)}, the proof says ${JSON.stringify(detail.suited)}`);
  return { summary, errors };
}

// ------------------------------------------------------------------------------------------------ checkOutcome

/** A round with an outcome to check: it has a round id, finished (not void) and states a detail. */
export function outcomeDetail(proof: RoundProof): Detail | null {
  if (!finished(proof)) return null;
  return detailOf(proof);
}

/** The proof is of a round that finished: a round id, an outcome, not void. */
function finished(proof: RoundProof): boolean {
  return proof.roundId !== null && proof.outcome !== null && proof.outcome !== undefined && (proof.outcome as { void?: unknown }).void !== true;
}

/**
 * Recompute a round's outcome from its draws and, for card games, the cards of its own shoe slice (null when the
 * shoes were not checked). A game without a mapping is not checked. A void round and the steps outside a round are
 * not checked either, but a game with a draw plan still holds them to it: a step outside a round must not draw, a
 * void round draws its plan or nothing.
 */
export function checkOutcome(proof: RoundProof, cards: RoundCards | null): OutcomeCheck {
  const unchecked: OutcomeCheck = { checked: false, summary: null, errors: [] };
  const draws = DRAW_MAPPINGS[proof.gameId];
  if (!finished(proof)) {
    if (!draws || !Array.isArray(proof.steps)) return unchecked;
    if (proof.roundId === null) {
      // The game draws only in its rounds: a draw outside one could be a filler before the next spin.
      const drew = proof.steps.filter((s) => s.status === 'ok' && Array.isArray(s.draws) && s.draws.length > 0);
      return { ...unchecked, errors: drew.map((s) => `nonce ${s.nonce} drew outside a round: ${proof.gameId} draws only its ${draws.what}`) };
    }
    const p = planned(proof, draws.plan, draws.what, true);
    return { ...unchecked, errors: 'errors' in p ? p.errors : [] };
  }
  const isBaccarat = BACCARAT_FULL.has(proof.gameId) || BACCARAT_VARIANTS.has(proof.gameId);
  const duel = DUELS[proof.gameId];
  if (!draws && !isBaccarat && !duel) return unchecked;
  const detail = detailOf(proof);
  // A mapped round that states no outcome would switch its checks off: the engines always state it.
  if (!detail) return { ...unchecked, errors: ['the proof states no outcome detail: the round of a mapped game must state its outcome'] };
  if (isBaccarat) {
    if (!cards) return unchecked;
    const r = baccaratOutcome(detail, cards);
    // A variant: the tableau is compared, the multipliers (strike draws) are not mapped, so the outcome is not checked.
    const full = BACCARAT_FULL.has(proof.gameId);
    return { checked: full, summary: full ? r.summary : `${r.summary} (multipliers not mapped)`, errors: r.errors };
  }
  if (duel) {
    if (!cards) return unchecked;
    const r = duelOutcome(duel, detail, cards);
    return { checked: true, summary: r.summary, errors: r.errors };
  }
  const m = draws!;
  const p = planned(proof, m.plan, m.what);
  if ('errors' in p) return { checked: true, summary: `not the ${m.what} of the game`, errors: p.errors };
  const r = m.map(p.v, detail);
  return { checked: true, summary: r.summary, errors: r.errors };
}

/** Games whose outcome the verifier recomputes in full (the others: draws and cards only). */
export const MAPPED_GAMES: readonly string[] = Object.freeze([...Object.keys(DRAW_MAPPINGS), ...BACCARAT_FULL, ...Object.keys(DUELS)].sort());
