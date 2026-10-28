import { auditDrawAuthorization } from './draw-authorization.ts';
import { checkBaccaratPayout } from './baccarat-payout.ts';
import { checkBlackjackPayout } from './blackjack-mapping.ts';
import { checkHiloPayout, checkTradingPayout } from './sequence-payout.ts';
import type { PayoutContext } from './payout-common.ts';
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
 * checked: the strike draws and their weight tables are not mapped yet. Solo blackjack gets its cards compared: the
 * cards its outcome names (every hand and the dealer) are the cards of the round's own slice, the first cards of its
 * shoe, as many and the same ones, and with the player's record of the round (the cards seen and where each went,
 * verifyShoe checks them against the shoe and the dealing rule) each hand of the outcome holds exactly the cards dealt
 * to it; its payouts are not mapped, so its outcome is not called checked. For every other game the draws (and cards) are verified, the outcome
 * is not (OutcomeCheck.checked false), so a verifier must not call that outcome checked.
 */
import type { GameplayState } from './gameplay.ts';
import type { RoundProof, StepProof } from './records.ts';
import { SOLO_BLACKJACK_GAMES } from './rules.ts';
import { baccaratValue, isCardCode, type CardCode } from './shoe.ts';

export interface OutcomeCheck {
  /** Independently replayed state, used only after verifying this predecessor proof. */
  state?: GameplayState;
  /** True only for a complete independently replayed payout, not merely cards or a winner. */
  payoutsChecked?: boolean;
  /**
   * True when this game has a full mapping and the outcome was recomputed (errors then lists every disagreement).
   * False for a game without one, for a void round and for steps outside a round; errors may still list a
   * disagreement of the part that is mapped (the tableau of a multiplier variant, the draw plan of a void round).
   */
  checked: boolean;
  /** What was compared, for a reader ("pocket 26", "crash 1.79x", "player 8D 4S (2), banker ..."). */
  summary: string | null;
  errors: string[];
  /** What the outcome leaves unbound (no error: the round is not provable). Solo blackjack: an outcome naming no cards. */
  unproven?: string[];
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

/** A card as an outcome names it: a code ("10H"), or `{ rank, suit }` (the reference server's history entry). */
function cardOf(v: unknown): CardCode | null {
  if (typeof v === 'string') return isCardCode(v) ? v : null;
  if (!v || typeof v !== 'object') return null;
  const c = v as { rank?: unknown; suit?: unknown };
  const code = `${String(c.rank)}${String(c.suit)}`;
  return typeof c.rank === 'string' && typeof c.suit === 'string' && isCardCode(code) ? code : null;
}

// ------------------------------------------------------------------------------------------------ solo blackjack

/** Where a card of a solo blackjack round went, as the player saw it dealt: the dealer, or hand `hand` of box `seat`. */
export type SeenPlace = 'dealer' | { seat: number; hand: number };

/**
 * A split the player saw: before card `at` of the round (an index into its cards), hand `hand` of box `seat` (two
 * cards) became two hands: its second card moved to a new hand right behind it (hand + 1, the later hands move up one).
 */
export interface SeenSplit {
  at: number;
  seat: number;
  hand: number;
}

/** What the player saw of a solo blackjack round (HandSeen): the cards, where each went, the splits, the boxes it bet. */
export interface BlackjackSeen {
  cards?: ReadonlyArray<CardCode | null>;
  places?: ReadonlyArray<SeenPlace>;
  splits?: ReadonlyArray<SeenSplit>;
  boxes?: readonly number[];
}

/** A solo blackjack round dealt by the rule of SPEC section 6: the cards (indexes into the round's slice) of every hand and of the dealer. */
export interface BlackjackDeal {
  /** The player's hands in the order of play: box by box in seat order, split hands in order. */
  hands: Array<{ seat: number; hand: number; cards: number[] }>;
  dealer: number[];
}

/** Boxes of a blackjack table: seats 0 to 15 at most; hands of a box: 16 at most (more is malformed). */
const MAX_SEATS = 16;
const isSeat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < MAX_SEATS;

function placeOf(p: unknown): SeenPlace | null {
  if (p === 'dealer') return 'dealer';
  if (!p || typeof p !== 'object') return null;
  const x = p as { seat?: unknown; hand?: unknown };
  return isSeat(x.seat) && isSeat(x.hand) ? { seat: x.seat, hand: x.hand } : null;
}

function placeName(p: SeenPlace | null): string {
  return p === null ? 'no place' : p === 'dealer' ? 'the dealer' : `box ${p.seat} hand ${p.hand}`;
}

const samePlace = (a: SeenPlace | null, b: SeenPlace | null): boolean => (a === 'dealer' || b === 'dealer' || a === null || b === null ? a === b : a.seat === b.seat && a.hand === b.hand);

/**
 * The places a solo blackjack round's cards went to, as the player saw them dealt, against the dealing rule (SPEC
 * section 6): the first deal gives box 1 card 1, box 2 card 1, ..., the dealer's up card, box 1 card 2, ..., the
 * dealer's hole card (face down: the only card dealt so), over exactly the boxes the player bet on; then every card goes
 * to the hand in turn (box by box in seat order, split hands in order: never back to a hand whose turn is over, the
 * split hand takes the card right after its split), and the dealer's draws come last. `count`: the cards of the
 * round's slice. Returns the deal (indexes into the slice), or what breaks the rule.
 */
export function blackjackDeal(seen: BlackjackSeen, count: number): { deal: BlackjackDeal } | { errors: string[] } {
  const { places, boxes, cards } = seen;
  const splits = seen.splits ?? [];
  if (!Array.isArray(boxes) || boxes.length === 0 || !boxes.every(isSeat) || boxes.some((s, i) => i > 0 && s <= boxes[i - 1]!)) {
    return { errors: ['the boxes the player bet on are not a list of seats in seat order'] };
  }
  if (!Array.isArray(places) || places.length !== count) return { errors: [`the player saw ${Array.isArray(places) ? places.length : 'no'} places for the ${count} cards of the round`] };
  if (!Array.isArray(splits) || !splits.every((s) => s && typeof s === 'object' && Number.isSafeInteger(s.at) && isSeat(s.seat) && isSeat(s.hand))) return { errors: ['the splits seen are not a list of splits'] };
  const b = boxes.length;
  const first = 2 * b + 2;
  const hole = 2 * b + 1;
  if (count < first) return { errors: [`the round has ${count} cards, the first deal to ${b} ${b === 1 ? 'box' : 'boxes'} and the dealer takes ${first}`] };
  const errors: string[] = [];
  const at = places.map(placeOf);
  // The first deal: box card 1 in seat order, the up card, box card 2 in seat order, the hole card.
  const rule = (i: number): SeenPlace => (i < b ? { seat: boxes[i]!, hand: 0 } : i === b || i === hole ? 'dealer' : { seat: boxes[i - b - 1]!, hand: 0 });
  for (let i = 0; i < first; i++) if (!samePlace(at[i]!, rule(i))) errors.push(`card ${i} went to ${placeName(at[i]!)}, the first deal gives it to ${placeName(rule(i))}`);
  if (Array.isArray(cards)) cards.forEach((c, i) => {
    if (c === null && i !== hole) errors.push(`card ${i} was dealt face down: only the dealer's hole card (card ${hole}) is`);
  });
  if (errors.length > 0) return { errors };
  const hands = new Map<number, number[][]>(boxes.map((s) => [s, [[]]]));
  const dealer: number[] = [];
  for (let i = 0; i < first; i++) {
    const p = at[i]!;
    if (p === 'dealer') dealer.push(i);
    else hands.get(p.seat)![0]!.push(i);
  }
  // The turn: box index and hand; a hand before it never takes a card again.
  let box = 0;
  let turn = 0;
  let dealerDrew = false;
  let next: { seat: number; hand: number } | null = null;
  const later = (bi: number, h: number): boolean => bi > box || (bi === box && h >= turn);
  let s = 0;
  for (let i = first; i <= count; i++) {
    for (; s < splits.length && splits[s]!.at === i; s++) {
      const { seat, hand } = splits[s]!;
      const bi = boxes.indexOf(seat);
      const list = hands.get(seat);
      if (bi < 0 || !list) errors.push(`before card ${i} the player saw box ${seat} split, a box it did not bet on`);
      else if (i === count) errors.push(`the round ends with a split of box ${seat} hand ${hand}: the split hand takes the next card`);
      else if (dealerDrew) errors.push(`before card ${i} the player saw box ${seat} hand ${hand} split after the dealer drew`);
      else if (!later(bi, hand)) errors.push(`before card ${i} the player saw box ${seat} hand ${hand} split after its turn`);
      else if (list[hand]?.length !== 2) errors.push(`before card ${i} the player saw box ${seat} hand ${hand} split with ${list[hand]?.length ?? 0} cards, not two`);
      else {
        list.splice(hand + 1, 0, [list[hand]!.pop()!]);
        box = bi;
        turn = hand;
        next = { seat, hand };
        continue;
      }
      return { errors };
    }
    if (i === count) break;
    const p = at[i]!;
    if (p === null) errors.push(`card ${i} went to no place the player could read`);
    else if (p === 'dealer') {
      if (next) errors.push(`card ${i} went to the dealer, the split hand box ${next.seat} hand ${next.hand} takes the card after its split`);
      dealerDrew = true;
      dealer.push(i);
    } else {
      const bi = boxes.indexOf(p.seat);
      const list = hands.get(p.seat);
      if (bi < 0 || !list) errors.push(`card ${i} went to box ${p.seat}, a box the player did not bet on`);
      else if (p.hand >= list.length) errors.push(`card ${i} went to box ${p.seat} hand ${p.hand}, which the box does not have`);
      else if (dealerDrew) errors.push(`card ${i} went to box ${p.seat} hand ${p.hand} after the dealer drew`);
      else if (!later(bi, p.hand)) errors.push(`card ${i} went to box ${p.seat} hand ${p.hand} after its turn was over`);
      else if (next && (next.seat !== p.seat || next.hand !== p.hand)) errors.push(`card ${i} went to box ${p.seat} hand ${p.hand}, the split hand box ${next.seat} hand ${next.hand} takes the card after its split`);
      else {
        box = bi;
        turn = p.hand;
        list[p.hand]!.push(i);
      }
    }
    next = null;
    if (errors.length > 0) return { errors };
  }
  if (s < splits.length) return { errors: [`a split seen before card ${String(splits[s]!.at)} is out of order or outside cards ${first} to ${count - 1}`] };
  const out: BlackjackDeal['hands'] = [];
  for (const seat of boxes) hands.get(seat)!.forEach((cards, hand) => out.push({ seat, hand, cards }));
  return { deal: { hands: out, dealer } };
}

/** The hands an outcome names (not the ones marked `behind`, which repeat another box's cards): seat and cards. */
function namedHands(outcome: Detail, bad: string[]): { hands: Array<{ seat: unknown; cards: CardCode[] }>; dealer: CardCode[] } {
  const list = (v: unknown, where: string): CardCode[] => {
    if (!Array.isArray(v)) {
      bad.push(`${where} has no list of cards`);
      return [];
    }
    const out: CardCode[] = [];
    for (const c of v) {
      const code = cardOf(c);
      if (code) out.push(code);
      else bad.push(`${where} names ${JSON.stringify(c)}, not a card`);
    }
    return out;
  };
  const hands: Array<{ seat: unknown; cards: CardCode[] }> = [];
  (outcome.hands as unknown[]).forEach((h, i) => {
    if (!h || typeof h !== 'object' || (h as { behind?: unknown }).behind === true) return;
    hands.push({ seat: (h as { seat?: unknown }).seat, cards: list((h as { cards?: unknown }).cards, `hand ${i + 1}`) });
  });
  return { hands, dealer: list(outcome.dealerCards, 'the dealer') };
}

/**
 * Solo blackjack: the cards the outcome names (`hands[].cards`, without the hands marked `behind`, which repeat another
 * box's cards, and `dealerCards`) are the round's own slice, as many and the same ones (the slice is in dealing order,
 * the outcome by hand). With the places the player saw the cards go to (`seen`, its record of the round; their rule is
 * checked by verifyShoe) every hand of the outcome is the hand the player saw, in order (box, cards in the order dealt),
 * and the dealer's cards are the ones dealt to the dealer. A server that made the slice longer than the cards played
 * (to skip cards), named other cards or gave the cards to other hands fails here.
 */
function blackjackOutcome(outcome: Detail, cards: RoundCards | null, seen: BlackjackSeen | null): { summary: string; errors: string[]; unproven?: string[] } {
  const hand = ownHand(cards);
  if ('errors' in hand) return { summary: 'no cards', errors: hand.errors };
  // An outcome that names no cards (a record of fairshoe@1.1.0 may) binds none: not an error, never provable.
  if (!Array.isArray(outcome.hands) || !Array.isArray(outcome.dealerCards)) return { summary: `cards ${hand.dealt.join(' ')}`, errors: [], unproven: ['the outcome names no cards of the round (hands, dealerCards)'] };
  const bad: string[] = [];
  const named = namedHands(outcome, bad);
  const all = [...named.hands.flatMap((h) => h.cards), ...named.dealer];
  const dealt = hand.dealt;
  let summary = `cards ${dealt.join(' ')}`;
  if (bad.length > 0) return { summary, errors: bad };
  if (all.length !== dealt.length) return { summary, errors: [`the outcome names ${all.length} cards (hands and dealer), the round's slice has ${dealt.length} (${dealt.join(' ')})`] };
  if ([...all].sort().join(' ') !== [...dealt].sort().join(' ')) return { summary, errors: [`the outcome names the cards ${all.join(' ')}, the round's slice has ${dealt.join(' ')}`] };
  const placed = seen && seen.places !== undefined ? blackjackDeal(seen, dealt.length) : null;
  // Without the places seen (or when they break the rule: verifyShoe says so) only the cards are compared.
  if (!placed || 'errors' in placed) return { summary, errors: [] };
  const codes = (ix: readonly number[]): string => ix.map((i) => dealt[i]).join(' ');
  const { deal } = placed;
  summary = [...deal.hands.map((h) => `box ${h.seat}${deal.hands.filter((x) => x.seat === h.seat).length > 1 ? ` hand ${h.hand}` : ''} ${codes(h.cards)}`), `dealer ${codes(deal.dealer)}`].join(', ');
  const errors: string[] = [];
  if (named.hands.length !== deal.hands.length) errors.push(`the outcome names ${named.hands.length} ${named.hands.length === 1 ? 'hand' : 'hands'}, the player saw ${deal.hands.length} dealt (${summary})`);
  else {
    deal.hands.forEach((h, k) => {
      const n = named.hands[k]!;
      const want = codes(h.cards);
      if (n.seat !== h.seat || n.cards.join(' ') !== want) errors.push(`hand ${k + 1} of the outcome is box ${String(n.seat)} ${n.cards.join(' ')}, the player saw box ${h.seat} hand ${h.hand} dealt ${want}`);
    });
  }
  if (named.dealer.join(' ') !== codes(deal.dealer)) errors.push(`the outcome gives the dealer ${named.dealer.join(' ')}, the player saw the dealer dealt ${codes(deal.dealer)}`);
  return { summary, errors };
}

/** The proof is of a round that finished: a round id, an outcome, not void. */
function finished(proof: RoundProof): boolean {
  return proof.roundId !== null && proof.outcome !== null && proof.outcome !== undefined && (proof.outcome as { void?: unknown }).void !== true;
}

/**
 * Recompute a round's outcome from its draws and, for card games, the cards of its own shoe slice (null when the
 * shoes were not checked). A game without a mapping is not checked. A void round and the steps outside a round are
 * not checked either, but a game with a draw plan still holds them to it: a step outside a round must not draw, a
 * void round draws its plan or nothing. `seen`: solo blackjack, the player's record of the round (HandSeen), which binds
 * every card of the outcome to the hand it was dealt to.
 */
function checkOutcomeInner(proof: RoundProof, cards: RoundCards | null, seen: BlackjackSeen | null = null, context: PayoutContext & { shoeStepIndex?: number; shoeSteps?: number } = {}): OutcomeCheck {
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
  if (SOLO_BLACKJACK_GAMES.has(proof.gameId)) {
    // The cards are compared, the payouts are not mapped: never called checked.
    if (!cards) return unchecked;
    if (!proof.outcome || typeof proof.outcome !== 'object') return { ...unchecked, errors: ['the proof states no outcome: a finished blackjack round names its cards'] };
    const r = blackjackOutcome(proof.outcome as Detail, cards, seen);
    if (!(proof.outcome as Detail).payoutProof && !context.gameplay) return { checked: false, payoutsChecked: false, summary: `${r.summary} (historical payouts not checked)`, errors: r.errors, ...(r.unproven ? { unproven: r.unproven } : {}) };
    const payout = checkBlackjackPayout(proof, cards, context);
    return { ...payout, payoutsChecked: payout.checked, errors: [...r.errors, ...payout.errors], unproven: [...(r.unproven ?? []), ...(payout.unproven ?? [])] };
  }
  if (proof.gameId === 'hilo' || proof.gameId === 'bull-run') {
    const payout = proof.gameId === 'hilo' ? checkHiloPayout(proof, context) : checkTradingPayout(proof, context);
    return { ...payout, payoutsChecked: payout.checked };
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
    if (detail.payoutProof) {
      const payout = checkBaccaratPayout(proof, cards, context);
      return { ...payout, payoutsChecked: payout.checked, errors: [...r.errors, ...payout.errors] };
    }
    const full = BACCARAT_FULL.has(proof.gameId);
    return { checked: full, payoutsChecked: false, summary: `${r.summary} (historical payouts not checked)`, errors: r.errors };
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

/** Authorization covers all random operations, not just draws after a server-announced nonce. */
export function checkOutcome(proof: RoundProof, cards: RoundCards | null, seen: BlackjackSeen | null = null, context: PayoutContext & { shoeStepIndex?: number; shoeSteps?: number } = {}): OutcomeCheck {
  const authorization = auditDrawAuthorization(proof, context);
  const result = checkOutcomeInner(proof, cards, seen, context);
  if (!authorization) return result;
  const incomplete = authorization.errors.length > 0 || (authorization.unproven?.length ?? 0) > 0;
  return { ...result, ...(incomplete ? { checked: false, payoutsChecked: false } : {}), errors: [...result.errors, ...authorization.errors], unproven: [...(result.unproven ?? []), ...(authorization.unproven ?? [])] };
}

/** Games whose outcome the verifier recomputes in full (the others: draws and cards only). */
export const MAPPED_GAMES: readonly string[] = Object.freeze([...Object.keys(DRAW_MAPPINGS), ...BACCARAT_FULL, ...BACCARAT_VARIANTS, ...SOLO_BLACKJACK_GAMES, 'hilo', 'bull-run', ...Object.keys(DUELS)].sort());
