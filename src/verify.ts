/**
 * Verifiers (SPEC.md section 8). They recompute everything from the published values and report every mismatch;
 * nothing here trusts the server. A verifier result lists errors in English, one line per problem; `ok` is true only
 * when there is none. A record whose client seed the server picked is reported as not provable (an error too): the
 * arithmetic may check out, but the server could have tried client seeds until it liked the outcome.
 *
 * What only the player can know is an input: the pair (seed id, game, hash and root) as shown before the player sent
 * the client seed, the client seed sent, the cut the player asked for, every hand it saw dealt, the table it bet at,
 * the reveals it received at the rotations, and the records the player received. Records alone cannot prove those, so
 * every record is checked against them: a server that swapped the server seed, the client seed, a chain or the root
 * after the player's client seed, or that dealt hands the player never saw to skip cards, fails here, however
 * consistent its records are. `provable` is true only when `ok` is, and only against such records: what is missing
 * for it is listed in `unproven`.
 */
import { fromHex, isHex } from './bytes.ts';
import { linkReaches, shoeRoot } from './chain.ts';
import { ALG, isClientSeed, isGameId, isTableRef } from './domains.ts';
import { CARD_GAMES, MAPPED_GAMES, checkOutcome, handRule, outcomeDetail, type OutcomeCheck } from './games.ts';
import type { ClientSeedBy, CutPolicy, RoundProof, SeedReveal, ShoeCommit, ShoeRecord, ShoeReveal } from './records.ts';
import { rootLineErrors, shoeRulesDiff, shoeRulesFor, type ShoeRulesV1 } from './rules.ts';
import { isServerSeed, roundRng, serverSeedHash } from './seeds.ts';
import { autoCut, BURN_RULES, burnOf, codesOf, isCardCode, isDigest, lettersOf, rotate, shoeHash, shoeOrder, shoeSalt, type CardCode } from './shoe.ts';
import { isIntRange } from './stream.ts';

export interface VerifyResult {
  ok: boolean;
  errors: string[];
}

/** A hand dealt from a shoe as the player saw it (note shoe_deal): its round (null: a free hand), cards [from, to). */
export interface HandSeen {
  roundId: string | null;
  from: number;
  to: number;
}

const NOT_PROVABLE = 'not provable: the server picked the client seed after its commitment';

/** The server seed matches its published hash. */
export function verifyServerSeed(serverSeed: string, hash: string): boolean {
  return isServerSeed(serverSeed) && isHex(hash, 32) && serverSeedHash(serverSeed) === hash;
}

/** The root hash covers these lines. */
export function verifyRoot(hash: string, lines: readonly string[]): boolean {
  return Array.isArray(lines) && lines.every((l) => typeof l === 'string') && shoeRoot(lines).hash === hash;
}

/**
 * A seed pair as the player kept it: the `fair` info shown before the player sent the client seed (FairInfo.active,
 * or FairInfo.next for the pair a rotation activates), with the game id and the client seed the player sent. Nothing
 * the server sends after that seed may stand in for it (a reveal, a later `fair`, `game_joined` after the seed):
 * those are the server's claims. The verifier trusts nothing else.
 */
export interface PairSeen {
  seedId: string;
  /** The game the pair is for (FairInfo.gameId): the shoe rules and root lines are that game's. */
  gameId: string;
  serverSeedHash: string;
  root: { hash: string; lines: readonly string[] } | null;
  /** The client seed the player sent (null: none; a server-picked seed is never provable). */
  clientSeed: string | null;
  clientSeedBy?: ClientSeedBy | null;
  committedAt: number;
  clientSeedAt: number | null;
  /** When the pair was revealed, once it was (SeedReveal.revealedAt): no shoe of its chains is committed later. */
  revealedAt?: number | null;
  /**
   * The reveal's last shoe numbers as the player received them at the rotation (fair_revealed / seed_reveal):
   * final, so a round of a later pair may come from a shoe of this pair's chains only up to them. Without them such
   * a round is not provable.
   */
  lastShoes?: ReadonlyArray<{ table: number; shoeNo: number }> | null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object';
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

// ------------------------------------------------------------------------------------------------ shoes

export interface ShoeVerifyOptions {
  /**
   * Required: the pair whose root binds the shoe's chain (origin.seedId), as the player kept it. Its root lines, its
   * client seed and its game are the ones the shoe must have; the rules are those of the pair's game.
   */
  pair: PairSeen;
  /** The game's shoe rules; default the published ones of the pair's game (rules.ts), never the commitment's. */
  rules?: ShoeRulesV1;
  /**
   * The cut the player asked for: a position (a player's cut) or 'auto'. Only the player knows it. A game that cuts
   * automatically only ('auto' cut policy) is always checked as 'auto'. Without it a shoe the player could cut is not
   * provable (the record's cut and its `by` are the server's word).
   */
  expectedCut?: { at: number } | 'auto';
  /**
   * Every hand the player saw dealt from this shoe, in order (the shoe_deal notes), free hands included: the reveal's
   * rounds must be exactly these. Without them a shoe with a cut card is not provable: a server that knows the order
   * could deal hands nobody asked for and so choose the cards of the player's next hand.
   */
  hands?: readonly HandSeen[];
}

export interface ShoeCheck extends VerifyResult {
  /** The dealing order D (O after the cut), when it could be computed. */
  dealing: CardCode[] | null;
  /** True only when ok is: the client seed was the player's and everything is bound to the kept pair and the player's records. */
  provable: boolean;
  /** While ok: what the player's records must add for the shoe to be provable (the cut asked for, the hands seen). */
  unproven?: string[];
}

const SHOE_ENDS = ['ended', 'shuffled', 'aborted'];
const CUT_BYS = ['player', 'auto', 'timeout'];
const CUT_POLICIES: readonly CutPolicy[] = ['player', 'auto'];

/** Field checks of a commitment before any computation; its card count (0 for a bad deck count). */
function commitShape(commit: ShoeCommit, errors: string[]): number {
  if (!isObject(commit)) {
    errors.push('the commitment is not an object');
    return 0;
  }
  if (commit.alg !== ALG) errors.push(`unknown algorithm ${String(commit.alg)}`);
  if (typeof commit.shoe !== 'string' || commit.shoe.length === 0) errors.push('bad shoe id');
  if (!isGameId(commit.gameId) || !isTableRef(commit.table) || !isClientSeed(commit.clientSeed)) errors.push('bad game id, table or client seed');
  if (commit.clientSeedBy !== 'player' && commit.clientSeedBy !== 'server') errors.push('the commitment does not say who set the client seed');
  const o = commit.origin;
  if (!isObject(o) || o.kind !== 'chain' || typeof o.seedId !== 'string' || typeof o.chainId !== 'string' || !isDigest(o.prevLink) || !isDigest(o.terminal) || !isDigest(o.root)) {
    errors.push('bad origin');
  }
  if (!Number.isSafeInteger(commit.shoeNo) || commit.shoeNo < 1 || o?.index !== commit.shoeNo) errors.push('bad shoe number');
  const decksOk = Number.isSafeInteger(commit.decks) && commit.decks >= 1 && commit.decks <= 64;
  if (!decksOk) errors.push('bad deck count');
  const size = decksOk ? commit.decks * 52 : 0;
  if (!BURN_RULES.includes(commit.burnRule)) errors.push(`unknown burn rule ${String(commit.burnRule)}`);
  if (!CUT_POLICIES.includes(commit.cutPolicy)) errors.push(`unknown cut policy ${String(commit.cutPolicy)}`);
  const range = commit.cutRange;
  if (!Array.isArray(range) || range.length !== 2 || !isCount(range[0]) || !isCount(range[1]) || range[0] > range[1] || range[1] >= size) errors.push('bad cut range');
  if (commit.endAt !== null && !(isCount(commit.endAt) && commit.endAt < size)) errors.push('bad cut card position');
  if (!isCount(commit.autoCut)) errors.push('bad automatic cut');
  if (!isDigest(commit.shoeHash)) errors.push('bad shoe hash');
  if (typeof commit.at !== 'number' || !Number.isFinite(commit.at)) errors.push('bad commitment time');
  return size;
}

/** Field checks before any computation: a malformed record gets errors, never an exception. */
function shoeShape(commit: ShoeCommit, reveal: ShoeReveal, errors: string[]): number | null {
  if (!isObject(commit) || !isObject(reveal)) {
    errors.push('the commitment or the reveal is not an object');
    return null;
  }
  const size = commitShape(commit, errors);
  if (reveal.shoe !== commit.shoe) errors.push('the reveal belongs to another shoe');
  if (!isDigest(reveal.link) || !isDigest(reveal.salt)) errors.push('bad link or salt');
  if (!SHOE_ENDS.includes(reveal.status)) errors.push(`unknown end ${String(reveal.status)}`);
  if (typeof reveal.order !== 'string' || reveal.order.length !== size) errors.push(`the order does not have ${size} cards`);
  if (reveal.cut !== null && !(isObject(reveal.cut) && Number.isSafeInteger(reveal.cut.at) && CUT_BYS.includes(reveal.cut.by))) errors.push('bad cut');
  if (reveal.burn !== null && !(isObject(reveal.burn) && isCount(reveal.burn.cards) && (reveal.burn.shown === null || isCardCode(reveal.burn.shown)))) errors.push('bad burn');
  if (!Array.isArray(reveal.rounds) || !reveal.rounds.every((r) => isObject(r) && (r.roundId === null || typeof r.roundId === 'string'))) errors.push('bad rounds');
  return errors.length === 0 ? size : null;
}

/** Root, pair and client seed: the order is bound to values the player kept from before the client seed. */
function shoeOrigin(commit: ShoeCommit, pair: PairSeen, rules: ShoeRulesV1 | null, errors: string[]): void {
  if (commit.clientSeedBy !== 'player') errors.push(NOT_PROVABLE);
  if (pair.seedId !== commit.origin.seedId) errors.push(`the shoe belongs to pair ${commit.origin.seedId}, not ${pair.seedId}`);
  const root = pair.root;
  if (!isObject(root) || !Array.isArray(root.lines)) {
    errors.push('the pair has no root: it has no shoe chains');
    return;
  }
  if (!verifyRoot(root.hash, root.lines)) errors.push('the root of the pair does not match its lines');
  if (root.hash !== commit.origin.root) errors.push('the root is not the one of the pair');
  if (rules) for (const e of rootLineErrors(pair.gameId, root.lines, rules.tables)) errors.push(e);
  if (!root.lines.includes(`${commit.gameId}:${commit.table}:${commit.origin.terminal}`)) errors.push('the chain terminal is not in the root');
  if (pair.clientSeed !== commit.clientSeed) errors.push('the client seed is not the one of the pair');
  if (pair.clientSeedAt === null || !(pair.clientSeedAt > pair.committedAt)) errors.push('the client seed was not set after the pair was shown');
  else if (commit.at < pair.clientSeedAt) errors.push('the shoe was opened before its client seed was set');
  if (typeof pair.revealedAt === 'number' && commit.at > pair.revealedAt) errors.push(`the shoe was committed at ${commit.at}, after its pair was revealed at ${pair.revealedAt}`);
}

/**
 * A shoe's commitment against its reveal: the rules are the game's published ones; the order is bound to the pair
 * (the link hashes to the previous link and, after shoeNo steps, to the terminal, which is in the pair's root); the
 * order is the shuffle of the shoe stream; salt and hash match; the cut is in range, follows the cut policy (an
 * automatic cut is kAuto) and, when given, is the one the player asked for; the burn follows the rule; the rounds
 * follow each other without gaps from the first card after the burn, and the round that dealt index endAt was the
 * last. The kept pair is required: the shoe must be of its game, its chain one of the game's tables in its root, its
 * client seed the one the player sent. Without it the order could come from any chain and any client seed.
 */
export function verifyShoe(commit: ShoeCommit, reveal: ShoeReveal, options: ShoeVerifyOptions): ShoeCheck {
  const errors: string[] = [];
  const unproven: string[] = [];
  let dealing: CardCode[] | null = null;
  try {
    const size = shoeShape(commit, reveal, errors);
    if (size === null) return { ok: false, errors, dealing: null, provable: false, unproven: [] };
    const opts: Partial<ShoeVerifyOptions> = options ?? {};
    const pair = opts.pair;
    if (!isObject(pair)) {
      errors.push('no pair: pass the pair as kept before the client seed was sent');
      return { ok: false, errors, dealing: null, provable: false, unproven: [] };
    }
    if (commit.gameId !== pair.gameId) errors.push(`the shoe is of ${commit.gameId}, the pair of ${String(pair.gameId)}`);
    const rules = opts.rules ?? (isGameId(pair.gameId) ? shoeRulesFor(pair.gameId) : null);
    if (!rules) errors.push(`no published shoe rules for ${String(pair.gameId)}`);
    else for (const d of shoeRulesDiff(commit, rules)) errors.push(`the commitment breaks the rules: ${d}`);
    shoeOrigin(commit, pair, rules, errors);

    const link = fromHex(reveal.link);
    const origin = commit.origin;
    if (!linkReaches(link, 1, origin.prevLink)) errors.push('the link does not hash to the previous link');
    if (!linkReaches(link, commit.shoeNo, origin.terminal)) errors.push('the link does not lead to the chain terminal');

    const inputs = { gameId: commit.gameId, table: commit.table, clientSeed: commit.clientSeed, shoeNo: commit.shoeNo };
    const order = shoeOrder(link, inputs, commit.decks).order;
    if (lettersOf(order) !== reveal.order) errors.push('the order is not the shuffle of the shoe stream');
    if (!sameHex(shoeSalt(link, inputs), reveal.salt)) errors.push('the salt is not the HMAC of the salt message');
    let revealed: CardCode[] = [];
    try {
      revealed = codesOf(reveal.order);
    } catch {
      errors.push('the order has a character that is not a card');
    }
    if (revealed.length === size && shoeHash(reveal.salt, revealed) !== commit.shoeHash) errors.push('the shoe hash does not match salt and order');
    const [min, max] = commit.cutRange;
    if (autoCut(inputs, min, max) !== commit.autoCut) errors.push('the automatic cut is not kAuto');
    if (!rules || errors.some((e) => e !== NOT_PROVABLE)) return { ok: false, errors, dealing: null, provable: false, unproven: [] };

    dealing = order;
    // The policy is the game's (the pair's), never the commitment's own word.
    const autoOnly = rules.cutPolicy === 'auto';
    const want = opts.expectedCut;
    if (reveal.cut) {
      const { at, by } = reveal.cut;
      if (at < min || at > max) errors.push(`cut ${at} is outside ${min} to ${max}`);
      else {
        if (by !== 'player' && at !== commit.autoCut) errors.push(`an automatic cut (${by}) must be ${commit.autoCut}, it was ${at}`);
        if (autoOnly && by !== 'auto') errors.push(`this game cuts automatically only, the record says ${by}`);
        dealing = rotate(order, at);
      }
      if (want === 'auto' && by !== 'auto') errors.push(`the player asked for the automatic cut, the record says ${by} at ${at}`);
      if (want && want !== 'auto' && (by !== 'player' || at !== want.at)) errors.push(`the player cut at ${want.at}, the record says ${by} at ${at}`);
    } else if (opts.expectedCut) errors.push('the player cut, the record has no cut');
    let next = 0;
    if (reveal.burn) {
      if (!reveal.cut) errors.push('a burn before the cut');
      const want = burnOf(commit.burnRule, dealing);
      if (want.cards !== reveal.burn.cards || want.shown !== reveal.burn.shown) errors.push(`the burn is not the ${commit.burnRule} rule`);
      next = reveal.burn.cards;
    } else if (commit.burnRule !== 'none' && reveal.rounds.length > 0) errors.push('cards dealt without the burn');
    if (reveal.rounds.length > 0 && !reveal.cut) errors.push('cards dealt before the cut');
    let lastDealtEnd = false;
    for (const r of reveal.rounds) {
      if (lastDealtEnd) errors.push(`round ${String(r.roundId)} after the round that brought the cut card out`);
      if (!Number.isSafeInteger(r.from) || !Number.isSafeInteger(r.to) || r.from !== next || r.to < r.from || r.to > size) {
        errors.push(`round ${String(r.roundId)}: cards ${String(r.from)} to ${String(r.to)} do not follow ${next}`);
        break;
      }
      next = r.to;
      if (commit.endAt !== null && r.from <= commit.endAt && commit.endAt < r.to) lastDealtEnd = true;
    }
    if (reveal.status === 'ended' && commit.endAt !== null && !lastDealtEnd) errors.push('the shoe ended before its cut card came out');
    if (reveal.status !== 'ended' && lastDealtEnd) errors.push(`the cut card came out, the shoe should have ended, not ${reveal.status}`);
    // A shoe for one round (no cut card): the round it was opened for and nothing else, from the first card after the burn.
    if (rules.endAt === null) {
      if (reveal.rounds.length > 1) errors.push(`a shoe for one round lists ${reveal.rounds.length} rounds`);
      if (reveal.rounds.some((r) => r.roundId === null)) errors.push('a shoe for one round lists a hand outside a round');
      if (reveal.status === 'ended' && reveal.rounds.length === 0) errors.push('a shoe for one round ended without its round');
    }
    // Every hand of a card game takes the cards its rules give (section 9), free hands too: a longer one skips cards.
    const rule = handRule(pair.gameId);
    if (rule) {
      for (const r of reveal.rounds) {
        if (!Number.isSafeInteger(r.from) || !Number.isSafeInteger(r.to)) continue;
        const want = rule(dealing, r.from);
        if (want !== r.to - r.from) errors.push(`${r.roundId === null ? 'the free hand' : `round ${r.roundId}`} at cards ${r.from} to ${r.to} takes ${r.to - r.from} cards, a hand of ${pair.gameId} takes ${String(want)} there`);
      }
    }
    // What the player saw: exactly these hands, no more (a hand nobody asked for skips cards), no fewer, none moved.
    const seen = opts.hands;
    if (seen !== undefined) {
      if (!Array.isArray(seen)) errors.push('the hands seen are not a list');
      else {
        const listed = reveal.rounds.map((r) => `${r.roundId === null ? 'free hand' : `round ${r.roundId}`} ${r.from}-${r.to}`);
        const mine = seen.map((r) => `${isObject(r) && r.roundId === null ? 'free hand' : `round ${String(r?.roundId)}`} ${String(r?.from)}-${String(r?.to)}`);
        if (listed.join(', ') !== mine.join(', ')) errors.push(`the shoe lists ${listed.join(', ') || 'no hand'}; the player saw ${mine.join(', ') || 'none'}`);
      }
    }
    if (errors.length === 0 && reveal.rounds.length > 0) {
      if (rules.cutPolicy === 'player' && want === undefined) unproven.push('the cut the player asked for on this shoe is not given');
      if (rules.endAt !== null && seen === undefined) unproven.push('the hands the player saw dealt from this shoe are not given');
    }
  } catch (err) {
    errors.push(`the record cannot be checked: ${errorText(err)}`);
    dealing = null;
  }
  const ok = errors.length === 0;
  return { ok, errors, dealing, provable: ok && unproven.length === 0, unproven: ok ? unproven : [] };
}

/** What a check before the reveal found: errors (a contradiction already), and what it could not bind yet. */
export interface BindingCheck extends VerifyResult {
  /** While ok: what is missing to bind the record at all (the kept pair). Never provable: the record is still pending. */
  unproven: string[];
}

/**
 * A shoe still in play, before its reveal: what its commitment binds already (SPEC section 8). Its fields; the game,
 * rules and cut policy of the kept pair's game; its origin (the pair, the root, the terminal among the root lines of
 * the game's tables), the client seed sent and set after the pair was shown, the commitment after it (and before the
 * pair's reveal); `clientSeedBy` "player"; kAuto recomputed. The order is still secret: ok says only that nothing
 * contradicts the kept pair. Without the pair the commitment is checked against the game's rules only.
 */
export function verifyShoeCommit(commit: ShoeCommit, options: { pair?: PairSeen | null; rules?: ShoeRulesV1 } = {}): BindingCheck {
  const errors: string[] = [];
  const unproven: string[] = [];
  try {
    commitShape(commit, errors);
    if (errors.length > 0) return { ok: false, errors, unproven: [] };
    const pair = options.pair ?? null;
    const game = isObject(pair) ? pair.gameId : commit.gameId;
    if (isObject(pair) && commit.gameId !== pair.gameId) errors.push(`the shoe is of ${commit.gameId}, the pair of ${String(pair.gameId)}`);
    const rules = options.rules ?? (isGameId(game) ? shoeRulesFor(game) : null);
    if (!rules) errors.push(`no published shoe rules for ${String(game)}`);
    else for (const d of shoeRulesDiff(commit, rules)) errors.push(`the commitment breaks the rules: ${d}`);
    if (isObject(pair)) shoeOrigin(commit, pair, rules, errors);
    else unproven.push('the pair of its chain as kept before the client seed is not given');
    const [min, max] = commit.cutRange;
    const inputs = { gameId: commit.gameId, table: commit.table, clientSeed: commit.clientSeed, shoeNo: commit.shoeNo };
    if (autoCut(inputs, min, max) !== commit.autoCut) errors.push('the automatic cut is not kAuto');
  } catch (err) {
    errors.push(`the commitment cannot be checked: ${errorText(err)}`);
  }
  const ok = errors.length === 0;
  return { ok, errors, unproven: ok ? unproven : [] };
}

/**
 * A round proof before its pair is revealed (no server seed yet): what it binds already (SPEC section 8). Its
 * algorithm and fields; against the kept pair of its seed id the game, the server seed hash and the client seed, set
 * after the pair was shown and not sent for another kept pair; `clientSeedBy` "player"; nonces increasing, known step
 * statuses, well-formed shoe slices. Its draws can be checked only with the server seed: ok says only that nothing
 * contradicts the kept pair.
 */
export function verifyProofBinding(proof: RoundProof, options: { pair?: PairSeen | null; pairs?: readonly PairSeen[] } = {}): BindingCheck {
  const errors: string[] = [];
  const unproven: string[] = [];
  try {
    if (!isObject(proof)) return { ok: false, errors: ['the proof is not an object'], unproven: [] };
    if (proof.alg !== ALG) errors.push(`unknown algorithm ${String(proof.alg)}`);
    if (typeof proof.id !== 'string' || typeof proof.seedId !== 'string') errors.push('bad proof or pair id');
    if (!isGameId(proof.gameId)) errors.push('bad game id');
    if (!isClientSeed(proof.clientSeed)) errors.push('bad client seed');
    if (!isHex(proof.serverSeedHash, 32)) errors.push('bad server seed hash');
    if (!Array.isArray(proof.steps) || !Array.isArray(proof.shoes)) errors.push('bad steps or shoes');
    if (errors.length > 0) return { ok: false, errors, unproven: [] };
    if (proof.clientSeedBy !== 'player') errors.push(proof.clientSeedBy === 'server' ? NOT_PROVABLE : 'the proof does not say who set the client seed');
    const kept = options.pair ?? options.pairs?.find((p) => p?.seedId === proof.seedId) ?? null;
    if (kept) {
      for (const e of keptErrors(kept, proof, 'proof')) errors.push(e);
      for (const e of reusedSeed(kept, options.pairs)) errors.push(e);
    } else unproven.push('the pair as kept before the client seed is not given');
    let last = -1;
    for (const step of proof.steps) {
      if (!isObject(step) || !Number.isSafeInteger(step.nonce) || step.nonce <= last) {
        errors.push(`nonce ${String(step?.nonce)}: not increasing`);
        continue;
      }
      last = step.nonce;
      if (step.status !== 'ok' && step.status !== 'discarded') errors.push(`nonce ${step.nonce}: unknown status ${String(step.status)}`);
    }
    for (const slice of proof.shoes) {
      if (!isObject(slice) || typeof slice.shoe !== 'string' || !isTableRef(slice.table) || !Number.isSafeInteger(slice.from) || !Number.isSafeInteger(slice.to)) errors.push(`bad shoe slice ${JSON.stringify(slice)}`);
    }
  } catch (err) {
    errors.push(`the proof cannot be checked: ${errorText(err)}`);
  }
  const ok = errors.length === 0;
  return { ok, errors, unproven: ok ? unproven : [] };
}

// ------------------------------------------------------------------------------------------------ rounds

export interface RoundVerifyOptions {
  /**
   * The proof's pair (proof.seedId) as the player kept it; when left out it is looked up in `pairs`. Without it the
   * proof is not provable: its server seed hash and client seed are bound to nothing the player saw.
   */
  pair?: PairSeen;
  /** Records of the shoes the round was dealt from (fair_shoe, /api/fair/shoe). Required when the proof has slices. */
  shoes?: readonly ShoeRecord[];
  /**
   * The kept pairs of those shoes (each shoe names its pair in origin.seedId): the proof's own and earlier ones, an
   * earlier one with the reveal received at its rotation (PairSeen.lastShoes). Pass every earlier kept pair of the
   * game: a client seed sent for two pairs shows against them.
   */
  pairs?: readonly PairSeen[];
  /**
   * The player's own records: the cut it asked for and the hands it saw on each shoe of the round, the table it bet
   * at. Without them a round from a shoe the player could cut, with a cut card or at a game of several tables is not
   * provable.
   */
  own?: PlayerRecords;
}

export interface RoundCheck extends VerifyResult {
  /** True only when ok is, the client seed was the player's and the proof is bound to the kept pair and the player's records. */
  provable: boolean;
  /** While ok: what is missing for the proof to be provable (the kept pair, the cut asked for, the hands seen, the table). */
  unproven?: string[];
  /** Cards of each shoe slice of the proof (dealing order), null when the proof has none or they could not be checked. */
  cards: CardCode[][] | null;
  /** The outcome recomputed from draws and cards (SPEC section 9); `checked` false for a game without a mapping. */
  outcome: OutcomeCheck;
}

/** What differs between a record of a pair and the pair as the player kept it. */
function keptErrors(kept: PairSeen, rec: { seedId: string; gameId: string; serverSeedHash: string; clientSeed: string | null }, what: string): string[] {
  const out: string[] = [];
  if (kept.seedId !== rec.seedId) out.push(`the ${what} belongs to pair ${String(rec.seedId)}, not ${String(kept.seedId)}`);
  if (kept.gameId !== rec.gameId) out.push(`the ${what} is of ${String(rec.gameId)}, the pair of ${String(kept.gameId)}`);
  if (kept.serverSeedHash !== rec.serverSeedHash) out.push(`the ${what} has another server seed hash than the pair kept before the client seed`);
  if (kept.clientSeed !== rec.clientSeed) out.push(`the ${what} has another client seed than the one sent (${String(kept.clientSeed)})`);
  if ((kept.clientSeed !== null || rec.clientSeed !== null) && (kept.clientSeedAt === null || !(kept.clientSeedAt > kept.committedAt))) out.push('the client seed was not set after the pair was shown');
  return out;
}

/**
 * The kept pair's client seed was sent for another kept pair of the game too. A client seed the server knew before it
 * made a pair lets it try server seeds and chains until it likes the outcomes. One sending that a rotation carried
 * over to the next pair (committed before it) is not a second use: both pairs keep the same clientSeedAt.
 */
function reusedSeed(kept: PairSeen, pairs: readonly PairSeen[] | undefined): string[] {
  if (typeof kept.clientSeed !== 'string') return [];
  const out: string[] = [];
  for (const p of pairs ?? []) {
    if (!isObject(p) || p.seedId === kept.seedId || p.clientSeed !== kept.clientSeed || p.clientSeedAt === kept.clientSeedAt) continue;
    out.push(`the client seed was sent for pair ${String(p.seedId)} too: a client seed used again proves nothing`);
  }
  return out;
}

/**
 * A round proof against its server seed (taken from the proof once revealed, or given): the seed matches the hash,
 * the hash, game and client seed are the kept pair's, every draw of every step is what int(n) gives on the round
 * stream of the step's nonce (with the same number of words read), every shoe slice is a round of a verified shoe of
 * the same game and table (the player's table when given), a shoe of an earlier pair lies within that pair's final
 * shoes, a card game's round has its own slice, and for a mapped game the outcome follows from the draws and cards.
 * Discarded steps are checked like the others and counted.
 */
export function verifyRound(proof: RoundProof, serverSeed: string | null = proof?.serverSeed ?? null, options: RoundVerifyOptions = {}): RoundCheck {
  const errors: string[] = [];
  const unproven: string[] = [];
  const none: OutcomeCheck = { checked: false, summary: null, errors: [] };
  const fail = (): RoundCheck => ({ ok: false, errors, provable: false, unproven: [], cards: null, outcome: none });
  try {
    if (!isObject(proof)) {
      errors.push('the proof is not an object');
      return fail();
    }
    if (proof.alg !== ALG) errors.push(`unknown algorithm ${String(proof.alg)}`);
    if (!isGameId(proof.gameId)) errors.push('bad game id');
    if (!isClientSeed(proof.clientSeed)) errors.push('bad client seed');
    if (!Array.isArray(proof.steps) || !Array.isArray(proof.shoes)) errors.push('bad steps or shoes');
    if (serverSeed === null || serverSeed === undefined) errors.push('the server seed is not revealed yet');
    else if (!verifyServerSeed(serverSeed, proof.serverSeedHash)) errors.push('the server seed does not match its hash');
    if (errors.length > 0) return fail();
    if (proof.clientSeedBy !== 'player') errors.push(proof.clientSeedBy === 'server' ? NOT_PROVABLE : 'the proof does not say who set the client seed');
    const kept = options.pair ?? options.pairs?.find((p) => p?.seedId === proof.seedId) ?? null;
    if (kept) {
      for (const e of keptErrors(kept, proof, 'proof')) errors.push(e);
      for (const e of reusedSeed(kept, options.pairs)) errors.push(e);
    } else unproven.push('the pair as kept before the client seed is not given');
    let last = -1;
    for (const step of proof.steps) {
      if (!isObject(step) || !Number.isSafeInteger(step.nonce) || step.nonce <= last) {
        errors.push(`nonce ${String(step?.nonce)}: not increasing`);
        continue;
      }
      if (step.status !== 'ok' && step.status !== 'discarded') errors.push(`nonce ${step.nonce}: unknown status ${String(step.status)}`);
      last = step.nonce;
      const rng = roundRng(serverSeed as string, proof.gameId, proof.clientSeed, step.nonce);
      let i = 0;
      const draws = Array.isArray(step.draws) ? step.draws : [];
      for (const d of draws) {
        if (!isObject(d) || !isIntRange(d.n)) {
          errors.push(`nonce ${step.nonce}, draw ${i}: bad range ${String(d?.n)}`);
          break;
        }
        const v = rng.int(d.n);
        if (v !== d.v) {
          errors.push(`nonce ${step.nonce}, draw ${i}: int(${d.n}) is ${v}, the proof says ${String(d.v)}`);
          break;
        }
        i++;
      }
      if (i === draws.length && rng.words !== step.words) errors.push(`nonce ${step.nonce}: ${rng.words} words read, the proof says ${String(step.words)}`);
    }
    // A round of a game with a shoe is dealt from a committed shoe (blackjack: its own): without its slice the cards
    // it claims are bound to nothing. The card family's mapping checks the one own slice itself (section 9).
    const rules = shoeRulesFor(proof.gameId);
    const dealt = rules !== null && proof.roundId !== null && proof.outcome !== null && (proof.outcome as { void?: unknown }).void !== true;
    if (dealt && proof.shoes.length === 0) errors.push('the round has no shoe slice: its cards are not on record');
    const slices = proof.shoes.length > 0 ? roundCards(proof, kept, options, errors, unproven) : null;
    const cards = slices?.cards ?? null;
    if (dealt && slices?.own && slices.own.length !== 1 && !CARD_GAMES.includes(proof.gameId)) errors.push(`the round has ${slices.own.length} shoe slices of its own, one expected`);
    // The table of the round: the one the player bet at, the one its hand was dealt at, the one its outcome names.
    if (slices?.ownTables && proof.roundId !== null) {
      const bet = options.own?.tables?.[proof.roundId];
      const named = outcomeDetail(proof)?.table;
      for (const t of new Set(slices.ownTables)) {
        if (bet !== undefined && t !== bet) errors.push(`the round was dealt at table ${t}, the player bet at table ${String(bet)}`);
        if (named !== undefined && named !== t) errors.push(`the outcome names table ${String(named)}, the round was dealt at table ${t}`);
      }
      if (dealt && rules.tables > 1 && bet === undefined) unproven.push(`the table the player bet at in round ${proof.roundId} is not given`);
    }
    // The round's own hands: the slices its shoes list under its round id (a free hand before it may ride along).
    const outcome = checkOutcome(proof, slices?.own ?? null);
    for (const e of outcome.errors) errors.push(`outcome: ${e}`);
    if (MAPPED_GAMES.includes(proof.gameId) && outcomeDetail(proof) && !outcome.checked) unproven.push('the outcome of this mapped game was not checked');
    const ok = errors.length === 0;
    return { ok, errors, provable: ok && unproven.length === 0, unproven: ok ? [...new Set(unproven)] : [], cards, outcome };
  } catch (err) {
    errors.push(`the proof cannot be checked: ${errorText(err)}`);
    return fail();
  }
}

/**
 * The cards of every slice, each checked against its verified shoe (of the proof's game, at the slice's table, under
 * its kept pair, with the player's cut and hands of that shoe); null (with errors) when one cannot be. `own`: the
 * slices the shoes list under the proof's round id, `ownTables` their tables. A shoe of another pair than the
 * proof's: only of an earlier pair whose chains still dealt after its rotation, within the last shoe numbers of its
 * reveal as the player received it, and never for a game that deals each round from a shoe of its own.
 */
function roundCards(
  proof: RoundProof,
  kept: PairSeen | null,
  options: RoundVerifyOptions,
  errors: string[],
  unproven: string[],
): { cards: CardCode[][] | null; own: CardCode[][] | null; ownTables: number[] | null } {
  const shoes = options.shoes ?? [];
  const own = options.own;
  const checked = new Map<string, ShoeCheck>();
  const out: CardCode[][] = [];
  const mine: CardCode[][] = [];
  const tables: number[] = [];
  let ok = true;
  for (const slice of proof.shoes) {
    if (!isObject(slice) || typeof slice.shoe !== 'string' || !isTableRef(slice.table) || !Number.isSafeInteger(slice.from) || !Number.isSafeInteger(slice.to)) {
      errors.push(`bad shoe slice ${JSON.stringify(slice)}`);
      ok = false;
      continue;
    }
    const record = shoes.find((s) => s?.commit?.shoe === slice.shoe);
    if (!record) {
      errors.push(`shoe ${slice.shoe}: record not given`);
      ok = false;
      continue;
    }
    if (!record.reveal) {
      errors.push(`shoe ${slice.shoe} is still running: its cards can be checked once it is revealed`);
      ok = false;
      continue;
    }
    let check = checked.get(slice.shoe);
    if (!check) {
      if (record.commit.gameId !== proof.gameId) errors.push(`shoe ${slice.shoe} is of ${String(record.commit.gameId)}, the round of ${proof.gameId}`);
      const seedId = record.commit.origin?.seedId;
      const pair = seedId === proof.seedId ? kept : (options.pairs?.find((p) => p?.seedId === seedId) ?? null);
      if (!pair) {
        errors.push(`shoe ${slice.shoe}: the pair ${String(seedId)} of its chain was not given as kept`);
        ok = false;
        continue;
      }
      if (seedId !== proof.seedId) {
        // A shoe that ran on across a rotation. Its pair's reveal fixed the last shoe of each chain for good.
        if (shoeRulesFor(proof.gameId)?.endAt === null) errors.push(`shoe ${slice.shoe} belongs to pair ${String(seedId)}: every round of ${proof.gameId} is dealt from a shoe of its own pair`);
        const last = Array.isArray(pair.lastShoes) ? pair.lastShoes.find((x) => isObject(x) && x.table === record.commit.table) : undefined;
        if (!Array.isArray(pair.lastShoes)) unproven.push(`the reveal of pair ${String(seedId)} as received at its rotation (its last shoe numbers) is not given`);
        else if (!last || record.commit.shoeNo > last.shoeNo) errors.push(`shoe ${slice.shoe} is shoe ${record.commit.shoeNo} of table ${record.commit.table} of pair ${String(seedId)}, whose reveal ended that chain at shoe ${String(last?.shoeNo ?? 0)}`);
      }
      const expectedCut = own?.cuts?.[slice.shoe];
      const hands = own?.hands?.[slice.shoe];
      check = verifyShoe(record.commit, record.reveal, { pair, ...(expectedCut !== undefined ? { expectedCut } : {}), ...(hands !== undefined ? { hands } : {}) });
      checked.set(slice.shoe, check);
      // A shoe under the same server-picked client seed is reported once, for the proof.
      for (const e of check.errors) if (e !== NOT_PROVABLE || proof.clientSeedBy === 'player') errors.push(`shoe ${slice.shoe}: ${e}`);
      for (const u of check.unproven ?? []) unproven.push(`shoe ${slice.shoe}: ${u}`);
    }
    if (record.commit.table !== slice.table) errors.push(`shoe ${slice.shoe} is at table ${String(record.commit.table)}, the round at table ${slice.table}`);
    if (!check.dealing) {
      ok = false;
      continue;
    }
    const round = record.reveal.rounds.find((r) => r.from === slice.from && r.to === slice.to);
    if (!round) errors.push(`shoe ${slice.shoe}: cards ${slice.from} to ${slice.to} are not a round of the shoe`);
    else if (round.roundId !== null && round.roundId !== proof.roundId) errors.push(`shoe ${slice.shoe}: cards ${slice.from} to ${slice.to} are round ${round.roundId}, not ${String(proof.roundId)}`);
    const cards = check.dealing.slice(slice.from, slice.to);
    out.push(cards);
    if (round && proof.roundId !== null && round.roundId === proof.roundId) {
      mine.push(cards);
      tables.push(slice.table);
    }
  }
  return ok ? { cards: out, own: mine, ownTables: tables } : { cards: null, own: null, ownTables: null };
}

// ------------------------------------------------------------------------------------------------ pairs

/**
 * A revealed pair: the seed matches its hash, the root matches its lines, the last shoe numbers name the root's
 * tables, and the client seed was the player's, set after the pair was shown (an unused pair needs none).
 */
export function verifySeedReveal(r: SeedReveal): VerifyResult {
  const errors: string[] = [];
  try {
    if (!isObject(r)) return { ok: false, errors: ['the reveal is not an object'] };
    if (!verifyServerSeed(r.serverSeed, r.serverSeedHash)) errors.push('the server seed does not match its hash');
    if (r.root && !verifyRoot(r.root.hash, r.root.lines)) errors.push('the root does not match its lines');
    if (!Number.isSafeInteger(r.lastNonce) || r.lastNonce < -1) errors.push('bad last nonce');
    const tables = (r.root?.lines ?? []).map((l) => Number(String(l).split(':')[1]));
    const last = Array.isArray(r.lastShoes) ? r.lastShoes : null;
    if (!last || !last.every((x) => isObject(x) && isTableRef(x.table) && isCount(x.shoeNo))) errors.push('bad last shoe numbers');
    else if (last.length !== tables.length || !tables.every((t) => last.filter((x) => x.table === t).length === 1)) errors.push('the last shoe numbers do not name the tables of the root');
    if (r.clientSeed === null) {
      if (r.lastNonce >= 0 || (last ?? []).some((x) => x.shoeNo > 0)) errors.push('nonces or shoes were spent without a client seed');
    } else {
      if (!isClientSeed(r.clientSeed)) errors.push('bad client seed');
      if (r.clientSeedBy !== 'player') errors.push(r.clientSeedBy === 'server' ? NOT_PROVABLE : 'the reveal does not say who set the client seed');
      if (r.clientSeedAt === null || !(r.clientSeedAt > r.committedAt)) errors.push('the client seed was not set after the pair was shown');
    }
  } catch (err) {
    errors.push(`the reveal cannot be checked: ${errorText(err)}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * What the player received and did, kept on the player's side (the server cannot take it back). It shows a record
 * that the server leaves out at the end of its lists, where no gap gives it away, and it binds what only the player
 * knows: the cuts it asked for, the hands it saw dealt, the tables it bet at.
 */
export interface PlayerRecords {
  /** Ids of the pair's proofs the player received (round_proof notes, fair_revealed / seed_reveal proofs). */
  proofs?: readonly string[];
  /** Ids of the shoes of the pair's chains whose commitment the player received (shoe_commit notes, game_joined). */
  shoes?: readonly string[];
  /** FairInfo.active.nonce of the pair as last seen before its rotation: nonces 0 ... nonce - 1 were spent by then. */
  nonce?: number;
  /** The cut the player asked for on each shoe it cut (shoe id -> a position, or 'auto' for cut_auto). */
  cuts?: Readonly<Record<string, { at: number } | 'auto'>>;
  /**
   * Every hand the player saw dealt from each shoe (shoe id -> the shoe_deal notes of that shoe in order, free hands
   * included). A shoe must list exactly these: a hand nobody asked for would skip cards the server knew.
   */
  hands?: Readonly<Record<string, readonly HandSeen[]>>;
  /** The table the player bet at in each round (round id -> table), for a game with several tables (baccarat). */
  tables?: Readonly<Record<string, number>>;
}

export interface PairVerifyOptions {
  /** Required: the pair as the player kept it before sending the client seed. The reveal and every record must match it. */
  pair: PairSeen;
  /**
   * Kept earlier pairs of the game: those whose shoes rounds of this pair were dealt from (a shoe that ran on across a
   * rotation, with the reveal received then: PairSeen.lastShoes), and every other, so that a client seed sent twice shows.
   */
  pairs?: readonly PairSeen[];
  /**
   * Proofs of later pairs whose rounds were dealt from shoes of this pair's chains after its rotation: every round a
   * shoe of this pair lists must be in one of its own proofs or of these.
   */
  later?: readonly RoundProof[];
  /** The player's own records of the pair. Without them a record missing at the end of the lists does not show. */
  own?: PlayerRecords;
}

export interface PairCheck extends VerifyResult {
  /** True only when ok is, against the player's own records (all of them given) and every record provable. */
  provable: boolean;
  /** While ok: what is missing for the pair to be provable. */
  unproven?: string[];
  counts: {
    proofs: number;
    /** Steps (= nonces) in the proofs, and how many of them were discarded. */
    steps: number;
    discarded: number;
    /** Rounds that never finished (their stake was returned). */
    voided: number;
    shoes: number;
    ended: number;
    shuffled: number;
    aborted: number;
    /** Shoes of the pair's chains still in play (a rotation does not end them): checkable once they are over. */
    running: number;
    /** Hands outside a round (free hands) the revealed shoes of the pair dealt. */
    free?: number;
  };
}

/** The same last shoe numbers (in any order). */
function sameLastShoes(a: ReadonlyArray<{ table: number; shoeNo: number }>, b: unknown): boolean {
  if (!Array.isArray(b)) return false;
  const key = (l: ReadonlyArray<{ table: number; shoeNo: number }>): string => l.map((x) => `${String(x?.table)}:${String(x?.shoeNo)}`).sort().join(',');
  return key(a) === key(b as Array<{ table: number; shoeNo: number }>);
}

/**
 * Everything on record for a revealed pair (PairRecords: every proof and every shoe of its chains), against the pair
 * as the player kept it: the reveal verifies and is the kept pair (seed id, game, hash, root, client seed, and the
 * last shoe numbers and time of the reveal received at the rotation when kept); every proof verifies under it; every
 * nonce 0 ... lastNonce is in exactly one proof; the shoes of each table are numbered 1 ... the reveal's last shoe
 * number without a gap, each verified against the kept pair (with the player's cut and hands), at most two of them
 * (the running one and one committed ahead) still in play at the reveal; every round a shoe lists under the id of one
 * of the proofs is in that proof, and every round a shoe of the pair lists is in a proof; the client seed was not
 * sent for another kept pair; and everything in the player's own records is there. Discarded steps, void rounds,
 * free hands and aborted shoes are counted: the verifier cannot tell why the server discarded or aborted them.
 * `shoes` may include shoes of earlier pairs that rounds of this pair were dealt from; `pairs` names those pairs.
 */
export function verifyPair(seed: SeedReveal, proofs: readonly RoundProof[], shoes: readonly ShoeRecord[], options: PairVerifyOptions): PairCheck {
  const errors: string[] = [];
  const unproven: string[] = [];
  const counts: PairCheck['counts'] = { proofs: 0, steps: 0, discarded: 0, voided: 0, shoes: 0, ended: 0, shuffled: 0, aborted: 0, running: 0, free: 0 };
  try {
    for (const e of verifySeedReveal(seed).errors) errors.push(`pair: ${e}`);
    const kept = options?.pair;
    if (!isObject(kept)) {
      errors.push('no pair: pass the pair as kept before the client seed was sent');
      return { ok: false, provable: false, unproven: [], errors, counts };
    }
    for (const e of keptErrors(kept, seed, 'reveal')) errors.push(`pair: ${e}`);
    if ((kept.root?.hash ?? null) !== (seed.root?.hash ?? null)) errors.push('pair: the revealed root is not the one kept before the client seed');
    // The reveal received at the rotation is the player's record: a later one must say the same.
    if (Array.isArray(kept.lastShoes) && !sameLastShoes(kept.lastShoes, seed.lastShoes)) errors.push('pair: the last shoe numbers are not those of the reveal received at the rotation');
    if (typeof kept.revealedAt === 'number' && kept.revealedAt !== seed.revealedAt) errors.push('pair: the reveal time is not that of the reveal received at the rotation');
    for (const e of reusedSeed(kept, options.pairs)) errors.push(`pair: ${e}`);
    const rules = shoeRulesFor(kept.gameId);
    if (rules && kept.root) for (const e of rootLineErrors(kept.gameId, kept.root.lines, rules.tables)) errors.push(`pair: ${e}`);
    const own = options.own;
    // The kept pair, now with its reveal time: no shoe of its chains may be committed after it.
    const pair: PairSeen = { ...kept, revealedAt: seed.revealedAt };
    const pairs: PairSeen[] = [pair, ...(options.pairs ?? []).filter((p) => p?.seedId !== pair.seedId)];
    const seen = new Map<number, number>();
    const mine: RoundProof[] = [];
    for (const p of proofs) {
      counts.proofs++;
      if (p.seedId !== seed.seedId || p.serverSeedHash !== seed.serverSeedHash) {
        errors.push(`proof ${p.id}: belongs to another pair`);
        continue;
      }
      mine.push(p);
      if ((p.outcome as { void?: unknown } | null)?.void === true) counts.voided++;
      for (const s of p.steps) {
        counts.steps++;
        if (s.status === 'discarded') counts.discarded++;
        seen.set(s.nonce, (seen.get(s.nonce) ?? 0) + 1);
      }
      const r = verifyRound(p, seed.serverSeed, { pair, shoes, pairs, ...(own ? { own } : {}) });
      for (const e of r.errors) if (e !== NOT_PROVABLE) errors.push(`proof ${p.id}: ${e}`);
      for (const u of r.unproven ?? []) unproven.push(`proof ${p.id}: ${u}`);
    }
    // Nonces 0 ... lastNonce, each in one proof; a run missing from the proofs is one line (a hostile lastNonce of
    // millions costs no loop over it).
    const lastNonce = Number.isSafeInteger(seed.lastNonce) ? seed.lastNonce : -1;
    const spent = [...seen.keys()].filter((n) => n >= 0 && n <= lastNonce).sort((a, b) => a - b);
    const missing = (from: number, to: number): void => {
      if (from <= to) errors.push(from === to ? `nonce ${from} is in no proof` : `nonces ${from} to ${to} are in no proof`);
    };
    let next = 0;
    for (const n of spent) {
      missing(next, n - 1);
      const c = seen.get(n)!;
      if (c > 1) errors.push(`nonce ${n} is in ${c} proofs`);
      next = n + 1;
    }
    missing(next, lastNonce);
    for (const n of seen.keys()) if (n > lastNonce || n < 0) errors.push(`nonce ${n} is outside 0 to ${String(seed.lastNonce)}`);
    const byTable = new Map<number, number[]>();
    for (const s of shoes) {
      if (s.commit.origin?.seedId !== seed.seedId) continue;
      counts.shoes++;
      byTable.set(s.commit.table, [...(byTable.get(s.commit.table) ?? []), s.commit.shoeNo]);
      if (!s.reveal) {
        counts.running++;
        continue;
      }
      counts[s.reveal.status]++;
      counts.free! += Array.isArray(s.reveal.rounds) ? s.reveal.rounds.filter((r) => r?.roundId === null).length : 0;
      const id = s.commit.shoe;
      const expectedCut = own?.cuts?.[id];
      const hands = own?.hands?.[id];
      const check = verifyShoe(s.commit, s.reveal, { pair, ...(expectedCut !== undefined ? { expectedCut } : {}), ...(hands !== undefined ? { hands } : {}) });
      for (const e of check.errors) if (e !== NOT_PROVABLE) errors.push(`shoe ${id}: ${e}`);
      for (const u of check.unproven ?? []) unproven.push(`shoe ${id}: ${u}`);
    }
    // At the reveal at most the running shoe of a table and one committed ahead were still in play (section 5): any
    // more would let the server choose between the old chain and the new one.
    const inPlay = new Map<number, number>();
    for (const s of shoes) if (s.commit.origin?.seedId === seed.seedId && (!s.reveal || s.reveal.at > seed.revealedAt)) inPlay.set(s.commit.table, (inPlay.get(s.commit.table) ?? 0) + 1);
    for (const [table, n] of inPlay) if (n > 2) errors.push(`table ${table}: ${n} shoes of the pair were still in play at its reveal, at most the running one and one committed ahead`);
    // Shoes 1 ... the last number the reveal gives for each chain, each exactly once.
    const last = new Map<number, number>((Array.isArray(seed.lastShoes) ? seed.lastShoes : []).map((x) => [x.table, x.shoeNo]));
    for (const table of byTable.keys()) if (!last.has(table)) errors.push(`table ${table}: shoes of a chain the reveal does not list`);
    for (const [table, lastNo] of last) {
      const sorted = [...(byTable.get(table) ?? [])].sort((a, b) => a - b);
      for (let no = 1; no <= Math.max(lastNo, sorted.length); no++) {
        if (sorted[no - 1] !== no || no > lastNo) {
          errors.push(`table ${table}: shoes 1 to ${lastNo} expected, found ${sorted.join(', ') || 'none'}`);
          break;
        }
      }
    }
    // Every round a shoe lists under the id of one of the proofs is a slice of that proof; every round a shoe of this
    // pair lists is a round on record (of this pair, or of a later one given): a round without a proof binds nothing.
    const later = (options.later ?? []).filter((p) => isObject(p) && p.seedId !== seed.seedId);
    for (const s of shoes) {
      if (!s.reveal) continue;
      const ofPair = s.commit.origin?.seedId === seed.seedId;
      for (const r of s.reveal.rounds) {
        if (r.roundId === null) continue;
        const p = mine.find((x) => x.roundId === r.roundId) ?? (ofPair ? later.find((x) => x.roundId === r.roundId) : undefined);
        if (p && !p.shoes.some((x) => x.shoe === s.commit.shoe && x.from === r.from && x.to === r.to)) errors.push(`proof ${p.id}: shoe ${s.commit.shoe} dealt cards ${r.from} to ${r.to} to round ${r.roundId}, the proof does not list them`);
        if (!p && ofPair) errors.push(`shoe ${s.commit.shoe} dealt cards ${r.from} to ${r.to} to round ${r.roundId}, which is in no proof given`);
      }
    }
    // What the player received must be on record.
    const proofIds = new Set(proofs.map((p) => p.id));
    for (const id of own?.proofs ?? []) if (!proofIds.has(id)) errors.push(`proof ${id}: received by the player, not on record`);
    const shoeIds = new Set(shoes.map((s) => s.commit.shoe));
    for (const id of own?.shoes ?? []) if (!shoeIds.has(id)) errors.push(`shoe ${id}: its commitment was received by the player, not on record`);
    if (own?.nonce !== undefined && (!Number.isSafeInteger(own.nonce) || seed.lastNonce < own.nonce - 1)) errors.push(`nonces 0 to ${String(own.nonce - 1)} were spent before the rotation, the reveal says 0 to ${seed.lastNonce}`);
    if (!own) unproven.push("the player's own records (proofs and shoes received, the nonce before the rotation) are not given");
    else {
      const missing = [own.proofs === undefined ? 'the proofs received' : '', own.shoes === undefined ? 'the shoe commitments received' : '', own.nonce === undefined ? 'the nonce before the rotation' : ''].filter(Boolean);
      if (missing.length > 0) unproven.push(`the player's own records lack ${missing.join(', ')}`);
    }
  } catch (err) {
    errors.push(`the pair cannot be checked: ${errorText(err)}`);
  }
  // One line per missing shoe number is enough.
  const unique = [...new Set(errors)];
  const ok = unique.length === 0;
  const open = ok ? [...new Set(unproven)] : [];
  return { ok, provable: ok && open.length === 0, unproven: open, errors: unique, counts };
}

function sameHex(bytes: Uint8Array, hex: string): boolean {
  const other = isHex(hex) ? fromHex(hex) : null;
  if (!other || other.length !== bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== other[i]) return false;
  return true;
}
