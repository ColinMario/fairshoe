/**
 * The published shoe rules of every game with a shoe (SPEC.md section 6). A shoe commitment states its rules,
 * and a verifier compares them with this table: a server cannot pick a cut range, a cut card or a burn per shoe (a
 * different cut range would even move kAuto), nor give a pair more chains than the game has tables. The rules always
 * come from the game the player plays (the pair's or the proof's game id), never from a commitment. Changing a row is
 * a change of the specification.
 */
import type { CutPolicy } from './records.ts';
import { CUT_MAX, CUT_MIN, type BurnRule } from './shoe.ts';

export interface ShoeRulesV1 {
  /** Tables of the game with a shoe: the pair's root has exactly one line per table, `{gameId}:{1 ... tables}:...`. */
  tables: number;
  decks: number;
  /** Cuts allowed: [min, max] cards from the front. */
  cutRange: readonly [number, number];
  /** Index (dealing order) of the first card behind the cut card; null: no cut card (a shoe for one round). */
  endAt: number | null;
  burn: BurnRule;
  /** 'player': the player may cut anywhere in the range (or cut automatically at kAuto); 'auto': only kAuto. */
  cutPolicy: CutPolicy;
}

/** Baccarat (12 tables), the four multiplier variants, Dragon Tiger, Card Duel (one table each). */
const cardFamily = (tables: number): ShoeRulesV1 => Object.freeze({ tables, decks: 8, cutRange: Object.freeze([CUT_MIN, CUT_MAX] as const), endAt: 364, burn: 'bac-value', cutPolicy: 'player' });
/** Solo blackjack: one table, a committed shoe per round, cut automatically at kAuto, no burn, no cut card. */
const SOLO_BLACKJACK: ShoeRulesV1 = Object.freeze({ tables: 1, decks: 8, cutRange: Object.freeze([CUT_MIN, CUT_MAX] as const), endAt: null, burn: 'none', cutPolicy: 'auto' });

/** Game id -> shoe rules (fairshoe/v1). */
export const SHOE_GAMES_V1: Readonly<Record<string, ShoeRulesV1>> = Object.freeze({
  baccarat: cardFamily(12),
  'blitz-baccarat': cardFamily(1),
  'gold-baccarat': cardFamily(1),
  'jade-baccarat': cardFamily(1),
  'blitz-baccarat-max': cardFamily(1),
  'dragon-tiger': cardFamily(1),
  'card-duel': cardFamily(1),
  'solo-classic': SOLO_BLACKJACK,
  'blitz-solo': SOLO_BLACKJACK,
  'freebet-solo': SOLO_BLACKJACK,
  'solo-vip': SOLO_BLACKJACK,
});

/** The published rules of a game's shoes, null for a game without a shoe (or unknown to v1). */
export function shoeRulesFor(gameId: string): ShoeRulesV1 | null {
  return Object.prototype.hasOwnProperty.call(SHOE_GAMES_V1, gameId) ? SHOE_GAMES_V1[gameId]! : null;
}

/** What a commitment says about its rules. */
export interface StatedShoeRules {
  decks: number;
  cutRange: readonly [number, number];
  endAt: number | null;
  burnRule: BurnRule;
  cutPolicy: CutPolicy;
}

/** Differences between a commitment's rules and the published ones (empty: they agree). */
export function shoeRulesDiff(stated: StatedShoeRules, rules: ShoeRulesV1): string[] {
  const out: string[] = [];
  if (stated.decks !== rules.decks) out.push(`decks ${String(stated.decks)}, the rules say ${rules.decks}`);
  const [min, max] = Array.isArray(stated.cutRange) ? stated.cutRange : [NaN, NaN];
  if (min !== rules.cutRange[0] || max !== rules.cutRange[1]) out.push(`cut range ${String(min)} to ${String(max)}, the rules say ${rules.cutRange[0]} to ${rules.cutRange[1]}`);
  if (stated.endAt !== rules.endAt) out.push(`cut card at ${String(stated.endAt)}, the rules say ${String(rules.endAt)}`);
  if (stated.burnRule !== rules.burn) out.push(`burn ${String(stated.burnRule)}, the rules say ${rules.burn}`);
  if (stated.cutPolicy !== rules.cutPolicy) out.push(`cut policy ${String(stated.cutPolicy)}, the rules say ${rules.cutPolicy}`);
  return out;
}

const TERMINAL = /^[0-9a-f]{64}$/;

/**
 * What is wrong with a pair's root lines for a game with `tables` tables (empty: nothing). The lines must be exactly
 * `{gameId}:{t}:{terminal}` for t = 1 ... tables, one each: a line of another game or an extra table would let the
 * server pick per round between several chains it fixed in advance.
 */
export function rootLineErrors(gameId: string, lines: readonly string[], tables: number): string[] {
  if (!Array.isArray(lines)) return ['the root lines are not a list'];
  const out: string[] = [];
  const seen = new Set<number>();
  for (const line of lines) {
    const parts = typeof line === 'string' ? line.split(':') : [];
    const t = parts.length === 3 && /^[1-9][0-9]*$/.test(parts[1]!) ? Number(parts[1]) : NaN;
    if (parts[0] !== gameId || !Number.isSafeInteger(t) || t > tables || !TERMINAL.test(parts[2]!)) out.push(`the root line ${String(line)} is not one of ${gameId} tables 1 to ${tables}`);
    else if (seen.has(t)) out.push(`the root has table ${t} twice`);
    else seen.add(t);
  }
  for (let t = 1; t <= tables; t++) if (!seen.has(t)) out.push(`the root has no line for ${gameId} table ${t}`);
  return out;
}
