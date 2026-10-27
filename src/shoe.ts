/**
 * Shoes (SPEC.md section 6): the starting order, the shuffle from the shoe stream, the salted commitment, the
 * automatic cut, the rotation by the cut and the burn rules.
 *
 * Life of a shoe: shuffle (order O) -> commit (shoe hash over a secret salt and O) -> cut k (a player's input after
 * the commit, or the automatic cut kAuto) -> dealing order D[i] = O[(i + k) mod size] -> burn -> deal -> reveal of the
 * chain link, the salt and O. A rotation of a uniformly shuffled order by any k that does not depend on O leaves it
 * uniform, so the cut changes the order, never the odds.
 */
import { concatBytes, fromHex, isHex, toHex, utf8 } from './bytes.ts';
import { checkInputs, message, type TableRef } from './domains.ts';
import { hmacSha256, sha256 } from './sha256.ts';
import { HmacStream, tapeRng, uniformInt, type Draw } from './stream.ts';

export type CardCode = string;

/** Suits and ranks in deck order: S, H, D, C, each A, 2 ... 10, J, Q, K (the ten is written "10"). */
export const SUITS = ['S', 'H', 'D', 'C'] as const;
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
/** The 52 cards of one deck in deck order. */
export const DECK_CODES: readonly CardCode[] = Object.freeze(SUITS.flatMap((s) => RANKS.map((r) => `${r}${s}`)));

/** Compact order: one letter per card, letter i ('A'-'Z', 'a'-'z') is DECK_CODES[i]. */
export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const INDEX_OF_CODE = new Map<CardCode, number>(DECK_CODES.map((c, i) => [c, i]));

/** Cut range of an eight-deck shoe: at least one deck stays in front and behind (SPEC.md 6.4). */
export const CUT_MIN = 52;
export const CUT_MAX = 364;

export type BurnRule =
  /** No burn (a shoe for one round). */
  | 'none'
  /** Blackjack: one card face down. */
  | 'bj-one-down'
  /** Baccarat family: the first card face up, then as many cards face down as its baccarat value (A 1, 10 J Q K 10). */
  | 'bac-value';

export const BURN_RULES: readonly BurnRule[] = ['none', 'bj-one-down', 'bac-value'];

export function isCardCode(value: unknown): value is CardCode {
  return typeof value === 'string' && INDEX_OF_CODE.has(value);
}

/** Letters of an order (for records: 416 characters instead of 1,200). */
export function lettersOf(order: readonly CardCode[]): string {
  let s = '';
  for (const c of order) {
    const i = INDEX_OF_CODE.get(c);
    if (i === undefined) throw new Error(`fairshoe: not a card code: ${c}`);
    s += LETTERS[i];
  }
  return s;
}

export function codesOf(letters: string): CardCode[] {
  const out: CardCode[] = [];
  for (const ch of letters) {
    const i = LETTERS.indexOf(ch);
    if (i < 0) throw new Error(`fairshoe: not a card letter: ${ch}`);
    out.push(DECK_CODES[i]!);
  }
  return out;
}

/** `decks` decks in deck order, one after the other. */
export function buildOrder(decks: number): CardCode[] {
  if (!Number.isSafeInteger(decks) || decks < 1 || decks > 64) throw new Error('fairshoe: bad deck count');
  const out: CardCode[] = [];
  for (let d = 0; d < decks; d++) out.push(...DECK_CODES);
  return out;
}

/** Fisher-Yates (Durstenfeld): for i = length - 1 down to 1, j = int(i + 1), swap a[i] and a[j]. */
export function shuffleInPlace<T>(a: T[], rng: { int(n: number): number }): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a;
}

/** What identifies a shoe: the game, the table, the client seed and the shoe number (chain index). */
export interface ShoeInputs {
  gameId: string;
  table: TableRef;
  clientSeed: string;
  /** Shoe number on the table's chain (1, 2, ...). */
  shoeNo: number;
}

function checkShoe(s: ShoeInputs): void {
  checkInputs({ gameId: s.gameId, table: s.table, clientSeed: s.clientSeed, counter: s.shoeNo });
}

/** The shuffled order O of a shoe and the draws of its shuffle (secret until the shoe is revealed). */
export function shoeOrder(link: Uint8Array, inputs: ShoeInputs, decks: number): { order: CardCode[]; draws: Draw[]; words: number } {
  checkShoe(inputs);
  const { gameId, table, clientSeed, shoeNo } = inputs;
  const rng = tapeRng(new HmacStream(link, (b) => message.shoe(gameId, table, clientSeed, shoeNo, b)));
  const order = shuffleInPlace(buildOrder(decks), rng);
  return { order, draws: rng.draws.slice(), words: rng.words };
}

/** The secret salt of the commitment (32 bytes): HMAC-SHA256(link, salt message). */
export function shoeSalt(link: Uint8Array, inputs: ShoeInputs): Uint8Array {
  checkShoe(inputs);
  return hmacSha256(link, utf8(message.salt(inputs.gameId, inputs.table, inputs.clientSeed, inputs.shoeNo)));
}

/** Shoe hash = SHA-256(salt as 32 raw bytes || UTF-8 of the card codes of O joined with ','), hex. */
export function shoeHash(salt: Uint8Array | string, order: readonly CardCode[]): string {
  const raw = typeof salt === 'string' ? fromHex(salt) : salt;
  if (raw.length !== 32) throw new Error('fairshoe: a salt has 32 bytes');
  for (const c of order) if (!isCardCode(c)) throw new Error(`fairshoe: not a card code: ${c}`);
  return toHex(sha256(concatBytes(raw, utf8(order.join(',')))));
}

/**
 * The automatic cut kAuto = min + int(max - min + 1) over the cut-auto stream (key: the client seed). It depends only
 * on values fixed before the shuffle, so it is independent of O and the server cannot steer it.
 */
export function autoCut(inputs: ShoeInputs, min = CUT_MIN, max = CUT_MAX): number {
  checkShoe(inputs);
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < min) throw new Error('fairshoe: bad cut range');
  const { gameId, table, clientSeed, shoeNo } = inputs;
  const stream = new HmacStream(utf8(clientSeed), (b) => message.cutAuto(gameId, table, shoeNo, b));
  return min + uniformInt(stream, max - min + 1);
}

/** The cut: the first k cards go to the back. D[i] = O[(i + k) mod size]. */
export function rotate<T>(order: readonly T[], k: number): T[] {
  if (!Number.isSafeInteger(k) || k < 0 || k >= Math.max(1, order.length)) throw new Error('fairshoe: bad cut');
  return [...order.slice(k), ...order.slice(0, k)];
}

/** Baccarat value: A 1, 2 to 9 by number, 10 J Q K 0. */
export function baccaratValue(code: CardCode): number {
  const rank = code.slice(0, -1);
  if (rank === 'A') return 1;
  if (rank === '10' || rank === 'J' || rank === 'Q' || rank === 'K') return 0;
  return Number(rank);
}

/** The burn of a shoe: cards that leave the dealing order D before the first round (D[0] onwards), and the one shown. */
export interface Burn {
  cards: number;
  shown: CardCode | null;
}

/** The burn a rule gives for a dealing order D. */
export function burnOf(rule: BurnRule, dealing: readonly CardCode[]): Burn {
  switch (rule) {
    case 'none':
      return { cards: 0, shown: null };
    case 'bj-one-down':
      return { cards: 1, shown: null };
    case 'bac-value': {
      const first = dealing[0];
      if (first === undefined) throw new Error('fairshoe: empty shoe');
      return { cards: 1 + (baccaratValue(first) || 10), shown: first };
    }
  }
}

/** True for a 32-byte value written as hex (links, salts, hashes). */
export function isDigest(value: unknown): value is string {
  return isHex(value, 32);
}
