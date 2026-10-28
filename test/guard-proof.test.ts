/** Independent adversarial checks for the public composition-guard proof boundary. No game/server imports. */
import { describe, expect, it } from './harness.ts';
import {
  ALG, CUT_MIN, CUT_MAX, autoCut, baccaratHand, baccaratGuardRates, burnOf, chainLink, chainTerminal,
  fromHex, guardBoard, guardDecisionErrors, guardShoeBoundaries, lettersOf, rootLine, rotate, serverSeedHash,
  shoeHash, shoeOrder, shoeRoot, shoeSalt, toHex, verifyShoe,
  type GuardDecision, type PairSeen, type ShoeCommit, type ShoeReveal, type ShoeVerifyOptions,
} from '../src/index.ts';

const SERVER_SEED = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const SECRET = fromHex('202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f');
const CLIENT_SEED = 'player-seed-01';
const RULE_SEEN = { guard: 'rtp-995', guardWeights: null } as const;

function fixture(cut = 52) {
  const gameId = 'baccarat', table = 3, shoeNo = 2, length = 3;
  const link = chainLink(SECRET, length, shoeNo);
  const inputs = { gameId, table, shoeNo, clientSeed: CLIENT_SEED };
  const order = shoeOrder(link, inputs, 8).order;
  const dealing = rotate(order, cut);
  const salt = shoeSalt(link, inputs);
  const terminal = toHex(chainTerminal(SECRET, length));
  const root = shoeRoot(Array.from({ length: 12 }, (_, i) => rootLine(gameId, i + 1,
    i + 1 === table ? terminal : toHex(new Uint8Array(32).fill(i + 1)))));
  const pair: PairSeen = { seedId: 's_guard', gameId, serverSeedHash: serverSeedHash(SERVER_SEED), root,
    clientSeed: CLIENT_SEED, clientSeedBy: 'player', committedAt: 10, clientSeedAt: 20 };
  const commit: ShoeCommit = {
    alg: ALG, shoe: 'sh_guard', gameId, table, shoeNo, decks: 8,
    origin: { kind: 'chain', seedId: pair.seedId, chainId: 'c_guard', index: shoeNo,
      prevLink: toHex(chainLink(SECRET, length, shoeNo - 1)), terminal, root: root.hash },
    clientSeed: CLIENT_SEED, clientSeedBy: 'player', shoeHash: shoeHash(salt, order),
    cutRange: [CUT_MIN, CUT_MAX], cutPolicy: 'player', autoCut: autoCut(inputs), endAt: 364,
    burnRule: 'bac-value', guard: 'rtp-995', at: 30,
  };
  const burn = burnOf('bac-value', dealing);
  const rounds: ShoeReveal['rounds'] = [];
  let from = burn.cards;
  while (from <= 364) {
    const to = from + baccaratHand(dealing.slice(from, from + 6))!.cards;
    rounds.push({ roundId: `R-${rounds.length + 1}`, from, to }); from = to;
  }
  const reveal: ShoeReveal = { shoe: commit.shoe, status: 'ended', link: toHex(link), salt: toHex(salt),
    order: lettersOf(order), cut: { at: cut, by: 'player' }, burn, rounds, at: 40 };
  const options = (r: ShoeReveal): ShoeVerifyOptions => ({ pair, expectedRules: RULE_SEEN,
    expectedCut: { at: cut }, hands: r.rounds, refused: r.rounds.map((hand) => ({ before: hand.from, requested: { player: 1000 }, granted: { player: 1000 } })) });
  return { commit, reveal, dealing, pair, options };
}

const FIRST = fixture();
const EARLY: ShoeReveal = { ...FIRST.reveal, rounds: FIRST.reveal.rounds.slice(0, 1), status: 'shuffled' };
const EARLY_END = EARLY.rounds[0]!.to;
const FIRST_BET = EARLY.burn!.cards;
const earlyOptions = (extra: Partial<ShoeVerifyOptions> = {}): ShoeVerifyOptions => ({ ...FIRST.options(EARLY), shuffles: [EARLY_END], ...extra });

const TRIGGERED = [52, 200, 364].map((cut) => {
  const f = fixture(cut);
  const boundaries = guardShoeBoundaries('baccarat', 3, f.dealing, f.reveal.burn, f.reveal.rounds);
  return { ...f, boundaries, first: boundaries.findIndex((b) => b.spot !== null) };
}).find((f) => f.first >= 0 && f.first < f.reveal.rounds.length)!;
if (!TRIGGERED) throw new Error('the fixed independent fixture must include an early guard trigger');
const AT_TRIGGER = TRIGGERED.boundaries[TRIGGERED.first]!;
const TRIGGER_RATE = AT_TRIGGER.rates[AT_TRIGGER.spot!]!;
const GUARDED: ShoeReveal = { ...TRIGGERED.reveal, status: 'guarded', rounds: TRIGGERED.reveal.rounds.slice(0, TRIGGERED.first),
  guard: { before: AT_TRIGGER.before, spot: AT_TRIGGER.spot!, num: TRIGGER_RATE.num.toString(), den: TRIGGER_RATE.den.toString() } };

// Literal published layout order: independently fixed here so an object-construction refactor cannot reorder trims.
const NC_SPOTS = ['player', 'banker', 'tie', 'player_pair', 'banker_pair', 'perfect_pair', 'either_pair', 'player_bonus', 'banker_bonus', 'super6'];

describe('public guard proof: stopping a shoe', () => {
  it('an arbitrary early shuffle stays unprovable without the matching own request', () => {
    const missing = verifyShoe(FIRST.commit, EARLY, { ...FIRST.options(EARLY) });
    expect(missing).toMatchObject({ ok: true, provable: false });
    expect(missing.unproven!.join(' ')).toMatch(/shuffle request/);
    expect(verifyShoe(FIRST.commit, EARLY, earlyOptions({ shuffles: [EARLY_END - 1] }))).toMatchObject({ ok: true, provable: false });
    expect(verifyShoe(FIRST.commit, EARLY, earlyOptions())).toMatchObject({ ok: true, provable: true });
  });

  it('the actual first guard trigger proves the end; a later hand cannot hide behind a forged reason', () => {
    const options = TRIGGERED.options(GUARDED);
    expect(verifyShoe(TRIGGERED.commit, GUARDED, options)).toMatchObject({ ok: true, provable: true });
    const late = { ...GUARDED, rounds: TRIGGERED.reveal.rounds.slice(0, TRIGGERED.first + 1) };
    expect(verifyShoe(TRIGGERED.commit, late, { ...options, hands: late.rounds }).errors.join(' ')).toMatch(/guard required a shuffle/);
    for (const guard of [
      { ...GUARDED.guard!, before: GUARDED.guard!.before + 1 },
      { ...GUARDED.guard!, spot: 'tie' },
      { ...GUARDED.guard!, num: '0' },
      { ...GUARDED.guard!, den: '1' },
    ]) expect(verifyShoe(TRIGGERED.commit, { ...GUARDED, guard }, options).ok).toBe(false);
    const earlyGuard = { ...EARLY, status: 'guarded' as const, guard: GUARDED.guard };
    expect(verifyShoe(FIRST.commit, earlyGuard, earlyOptions()).errors.join(' ')).toMatch(/no guard trigger/);
  });
});

describe('public guard proof: the original requested board', () => {
  it('a valid board cannot be refused, shrunk or inflated under a guard excuse', () => {
    const requested = { player: 1000 };
    const grants: Array<Record<string, number> | null> = [null, { player: 900 }, { player: 1001 }, { banker: 1000 }];
    for (const granted of grants) {
      const decision: GuardDecision = { before: FIRST_BET, requested, granted };
      expect(verifyShoe(FIRST.commit, EARLY, earlyOptions({ refused: [decision] })).ok).toBe(false);
    }
    expect(verifyShoe(FIRST.commit, EARLY, earlyOptions({ refused: [{ before: FIRST_BET, requested, granted: requested }] }))).toMatchObject({ ok: true, provable: true });
  });

  it('a missing own board cannot silently certify a paid guarded hand', () => {
    const result = verifyShoe(FIRST.commit, EARLY, earlyOptions({ refused: [] }));
    expect(result).toMatchObject({ ok: true, provable: false });
    expect(result.unproven!.join(' ')).toMatch(/requested and granted board/);
  });

  it('a lost response is unproven, not a fabricated rejection verdict', () => {
    const decision: GuardDecision = { before: FIRST_BET, requested: { player: 1000 }, granted: null, unanswered: true };
    const result = verifyShoe(FIRST.commit, EARLY, earlyOptions({ refused: [decision] }));
    expect(result).toMatchObject({ ok: true, provable: false, errors: [] });
    expect(result.unproven!.join(' ')).toMatch(/no received response/);
  });

  it('a non-guard refusal remains unproven instead of accusing a valid funds rejection of guard fraud', () => {
    const decision: GuardDecision = { before: FIRST_BET, requested: { player: 1000 }, granted: null, refusal: 'insufficient_funds' };
    expect(verifyShoe(FIRST.commit, EARLY, earlyOptions({ refused: [decision] }))).toMatchObject({ ok: true, provable: false, errors: [] });
    expect(verifyShoe(FIRST.commit, EARLY, earlyOptions({ refused: [{ ...decision, refusal: 'guard_limit' }] })).ok).toBe(false);
  });

  it('binds a decision to a real hand boundary; fresh before-cut requests map only to the first boundary', () => {
    const requested = { player: 1000 };
    expect(verifyShoe(FIRST.commit, EARLY, earlyOptions({ refused: [{ before: 0, requested, granted: requested }] }))).toMatchObject({ ok: true, provable: true });
    for (const before of [-1, FIRST_BET + 1, 1.5, 416]) {
      expect(verifyShoe(FIRST.commit, EARLY, earlyOptions({ refused: [{ before, requested, granted: requested }] })).ok).toBe(false);
    }
  });

  it('refuses an uncovered side-only board and detects acceptance despite that refusal rule', () => {
    const rates = { player: { num: 98n, den: 100n }, tie: { num: 11n, den: 10n } };
    const decision: GuardDecision = { before: 50, requested: { tie: 1000 }, granted: null };
    expect(guardDecisionErrors('baccarat', rates, decision)).toEqual([]);
    expect(guardDecisionErrors('baccarat', rates, { ...decision, granted: { tie: 1000 } })).not.toEqual([]);
  });

  it('uses the published trim order even when several correlated side bets consume the coverage', () => {
    const unseen = [4,0,0,0,4,3,4,1,3,0,0,0,1,1,0,3,4,3,1,4,3,0,2,0,3,3,0,0,1,2,0,3,0,1,2,4,0,3,4,0,0,3,3,0,4,4,0,1,0,3,4,2];
    const rates = baccaratGuardRates(unseen, 'no-commission');
    const requested = Object.fromEntries(NC_SPOTS.map((spot) => [spot, 1000]));
    const granted = { player: 1000, banker: 1000, tie: 1000, player_pair: 1000, banker_pair: 1000, perfect_pair: 500, either_pair: 1000, player_bonus: 248, banker_bonus: 500, super6: 500 };
    const calculated = guardBoard(requested, rates, NC_SPOTS, { minimum: 100, main: ['player', 'banker'], sideRatio: { num: 1n, den: 4n }, sideRatioSpots: ['player_bonus', 'banker_bonus', 'perfect_pair', 'super6'] });
    expect(calculated.bets).toEqual(granted);
    expect(guardDecisionErrors('baccarat', rates, { before: 320, requested, granted })).toEqual([]);
    expect(guardDecisionErrors('baccarat', rates, { before: 320, requested, granted: { ...granted, player_bonus: 249 } })).not.toEqual([]);
  });
});

describe('public guard proof: historical records and downgrade resistance', () => {
  it('keeps a marker-free historical randomness proof valid, while refusing a new claim that its end was guarded', () => {
    const legacy = { ...FIRST.commit }; delete legacy.guard;
    const options = { ...FIRST.options(FIRST.reveal), expectedRules: { guard: null, guardWeights: null } as const };
    expect(verifyShoe(legacy, FIRST.reveal, options)).toMatchObject({ ok: true, provable: true });
    expect(verifyShoe(legacy, { ...FIRST.reveal, status: 'guarded', guard: GUARDED.guard }, options).ok).toBe(false);
  });

  it('detects stripping or adding guard markers relative to the commitment the player kept', () => {
    const stripped = { ...FIRST.commit }; delete stripped.guard;
    expect(verifyShoe(stripped, EARLY, earlyOptions()).errors.join(' ')).toMatch(/guard rule differs/);
    expect(verifyShoe(FIRST.commit, EARLY, earlyOptions({ expectedRules: { guard: null, guardWeights: null } })).errors.join(' ')).toMatch(/guard rule differs/);
    expect(verifyShoe({ ...FIRST.commit, guardWeights: 'baccarat-multiplier/1' }, EARLY, earlyOptions()).ok).toBe(false);
  });
});
