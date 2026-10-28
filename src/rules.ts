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
  /**
   * A commitment may also state cut policy 'auto' (only kAuto): the solo row of fairshoe@1.1.0, under which the
   * reference server dealt every solo round cut at kAuto. Such a shoe is held to it (an automatic cut only), so a
   * record of 1.1.0 stays valid; it is never looser than the row.
   */
  autoToo?: true;
  guard?: 'rtp-995';
  guardWeights?: 'baccarat-multiplier/1';
  /** Historical Max shoes had a cut card, only valid without a guard marker. */
  legacyEndAt?: number;
}

/** Baccarat (12 tables), the four multiplier variants, Dragon Tiger, Card Duel (one table each). */
const cardFamily = (tables: number, multiplier = false): ShoeRulesV1 => Object.freeze({ tables, decks: 8, cutRange: Object.freeze([CUT_MIN, CUT_MAX] as const), endAt: 364, burn: 'bac-value', cutPolicy: 'player', guard: 'rtp-995', ...(multiplier ? { guardWeights: 'baccarat-multiplier/1' as const } : {}) });
/**
 * Solo blackjack: one table, a fresh committed shoe of eight decks for every round, cut by the player anywhere in the
 * range or automatically at kAuto, no burn, no cut card (fairshoe@1.2.0). A shoe committed under the row of 1.1.0
 * (cut policy 'auto': kAuto only) is still accepted and held to that.
 */
const SOLO_BLACKJACK: ShoeRulesV1 = Object.freeze({ tables: 1, decks: 8, cutRange: Object.freeze([CUT_MIN, CUT_MAX] as const), endAt: null, burn: 'none', cutPolicy: 'player', autoToo: true });

/** The solo blackjack tables (game id = table id): one shoe per round, hands of no fixed length. */
export const SOLO_BLACKJACK_GAMES: ReadonlySet<string> = new Set(['solo-classic', 'blitz-solo', 'freebet-solo', 'solo-vip']);

/** Game id -> shoe rules (fairshoe/v1). */
export const SHOE_GAMES_V1: Readonly<Record<string, ShoeRulesV1>> = Object.freeze({
  baccarat: cardFamily(12),
  'blitz-baccarat': cardFamily(1, true),
  'gold-baccarat': cardFamily(1, true),
  'jade-baccarat': cardFamily(1, true),
  'blitz-baccarat-max': Object.freeze({ ...cardFamily(1, true), endAt: null, legacyEndAt: 364 }),
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
  guard?: 'rtp-995';
  guardWeights?: 'baccarat-multiplier/1';
}

/** Differences between a commitment's rules and the published ones (empty: they agree). */
export function shoeRulesDiff(stated: StatedShoeRules, rules: ShoeRulesV1): string[] {
  const out: string[] = [];
  if (stated.decks !== rules.decks) out.push(`decks ${String(stated.decks)}, the rules say ${rules.decks}`);
  const [min, max] = Array.isArray(stated.cutRange) ? stated.cutRange : [NaN, NaN];
  if (min !== rules.cutRange[0] || max !== rules.cutRange[1]) out.push(`cut range ${String(min)} to ${String(max)}, the rules say ${rules.cutRange[0]} to ${rules.cutRange[1]}`);
  if (stated.endAt !== rules.endAt && !(stated.guard === undefined && stated.endAt === rules.legacyEndAt)) out.push(`cut card at ${String(stated.endAt)}, the rules say ${String(rules.endAt)}`);
  if (stated.burnRule !== rules.burn) out.push(`burn ${String(stated.burnRule)}, the rules say ${rules.burn}`);
  if (stated.cutPolicy !== rules.cutPolicy && !(stated.cutPolicy === 'auto' && rules.autoToo)) out.push(`cut policy ${String(stated.cutPolicy)}, the rules say ${rules.cutPolicy}`);
  if (stated.guard !== undefined && stated.guard !== rules.guard) out.push('unknown guard rule');
  if (stated.guard !== undefined && stated.guardWeights !== rules.guardWeights) out.push('guard weights do not match the published table');
  if (stated.guard === undefined && stated.guardWeights !== undefined) out.push('guard weights without a guard rule');
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
