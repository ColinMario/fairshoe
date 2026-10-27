/** Verifiers: a correct record passes, every kind of tampering is reported. Plus the distribution properties. */
import { describe, expect, it } from './harness.ts';
import {
  ALG,
  autoCut,
  baccaratHand,
  burnOf,
  chainLink,
  chainTerminal,
  checkOutcome,
  crashPoint,
  CUT_MAX,
  CUT_MIN,
  fromHex,
  HmacStream,
  isTableRef,
  LIB,
  lettersOf,
  message,
  rootLine,
  rotate,
  roundRng,
  serverSeedHash,
  shoeHash,
  shoeOrder,
  shoeRoot,
  shoeRulesFor,
  shoeSalt,
  shuffleInPlace,
  tapeRng,
  toHex,
  uniformInt,
  verifyPair,
  verifyRound,
  verifySeedReveal,
  verifyShoe,
  type PairSeen,
  type RoundProof,
  type SeedReveal,
  type ShoeCommit,
  type ShoeReveal,
} from '../src/index.ts';

const SEED = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const SECRET = fromHex('202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f');
const CS = 'player-seed-01';
const NOT_PROVABLE = /not provable/;

/** A pair as the player kept it before sending CS (no shoe chains). */
function keptPair(gameId: string, seedId = 's_test', extra: Partial<PairSeen> = {}): PairSeen {
  return { seedId, gameId, serverSeedHash: serverSeedHash(SEED), root: null, clientSeed: CS, clientSeedBy: 'player', committedAt: 10, clientSeedAt: 20, ...extra };
}

function proofOf(gameId: string, nonces: number[], draw: (r: ReturnType<typeof roundRng>) => void, extra: Partial<RoundProof> = {}): RoundProof {
  return {
    v: 1,
    alg: ALG,
    lib: LIB,
    id: 'p_test',
    gameId,
    roundId: 'R-1',
    seedId: 's_test',
    serverSeedHash: serverSeedHash(SEED),
    clientSeed: CS,
    clientSeedBy: 'player',
    serverSeed: null,
    steps: nonces.map((nonce) => {
      const r = roundRng(SEED, gameId, CS, nonce);
      draw(r);
      return { nonce, kind: 'act', status: 'ok', draws: r.draws.slice(), words: r.words };
    }),
    shoes: [],
    outcome: null,
    engineVersion: 1,
    at: 0,
    ...extra,
  };
}

describe('verifyRound', () => {
  const good = proofOf('craps', [3, 4], (r) => {
    r.int(6);
    r.int(6);
  });

  it('accepts a correct proof once the seed is known; provable only against the pair kept before the client seed', () => {
    expect(verifyRound(good, SEED, { pair: keptPair('craps') })).toMatchObject({ ok: true, errors: [], provable: true, cards: null, outcome: { checked: false } });
    expect(verifyRound({ ...good, serverSeed: SEED }, undefined, { pairs: [keptPair('craps')] })).toMatchObject({ ok: true, provable: true });
    // Without the kept pair the arithmetic checks out, but nothing binds the hash and the client seed: not provable.
    expect(verifyRound(good, SEED)).toMatchObject({ ok: true, provable: false });
  });

  it('cannot verify before the seed is revealed', () => {
    expect(verifyRound(good).ok).toBe(false);
  });

  it('a client seed the server picked is not provable, and so is a proof that does not say who set it', () => {
    const server = verifyRound({ ...good, clientSeedBy: 'server' }, SEED, { pair: keptPair('craps') });
    expect(server).toMatchObject({ ok: false, provable: false });
    expect(server.errors.join()).toMatch(NOT_PROVABLE);
    const { clientSeedBy: _, ...unsaid } = good;
    expect(verifyRound(unsaid as RoundProof, SEED).errors.join()).toMatch(/who set the client seed/);
  });

  it('reports a changed value, a changed word count, a wrong seed and nonces out of order', () => {
    const changed = structuredClone(good);
    changed.steps[1]!.draws[0]!.v = (changed.steps[1]!.draws[0]!.v + 1) % 6;
    expect(verifyRound(changed, SEED).errors[0]).toMatch(/nonce 4, draw 0/);
    const words = structuredClone(good);
    words.steps[0]!.words += 1;
    expect(verifyRound(words, SEED).errors[0]).toMatch(/words/);
    expect(verifyRound(good, SEED.replace(/^00/, '01')).errors).toEqual(['the server seed does not match its hash']);
    const order = structuredClone(good);
    order.steps.reverse();
    expect(verifyRound(order, SEED).ok).toBe(false);
  });

  it('never throws on a malformed proof', () => {
    expect(verifyRound(null as unknown as RoundProof, SEED).ok).toBe(false);
    expect(verifyRound({ ...good, steps: [{ nonce: 3 } as never] }, SEED).ok).toBe(false);
  });

  it('roulette: the pocket is the int(37) of the spin; a proof that claims another pocket fails', () => {
    let pocket = -1;
    const spin = proofOf('roulette', [7], (r) => (pocket = r.int(37)), {});
    const right = { ...spin, outcome: { result: { kind: 'number', n: pocket }, detail: { pocket } } };
    expect(verifyRound(right, SEED, { pair: keptPair('roulette') })).toMatchObject({ ok: true, provable: true, outcome: { checked: true, summary: `pocket ${pocket}` } });
    const wrong = { ...spin, outcome: { result: { kind: 'number', n: pocket }, detail: { pocket: (pocket + 1) % 37 } } };
    expect(verifyRound(wrong, SEED).errors.join()).toMatch(/outcome: the draws give pocket/);
    // A discarded step does not count: the pocket is the applied spin's.
    const refused = proofOf('roulette', [6, 7], (r) => r.int(37));
    refused.steps[0]!.status = 'discarded';
    expect(verifyRound({ ...refused, outcome: { detail: { pocket } } }, SEED).ok).toBe(true);
  });

  it('american roulette maps 37 to "00"; high flyer maps the draw to its crash point', () => {
    expect(checkOutcome({ ...proofOf('american-roulette', [], () => undefined), steps: [{ nonce: 0, kind: 'act', status: 'ok', draws: [{ n: 38, v: 37 }], words: 1 }], outcome: { detail: { pocket: '00' } } }, null)).toMatchObject({ checked: true, errors: [] });
    expect(crashPoint(0)).toBe(100);
    expect(crashPoint(2 ** 32 - 1)).toBe(2_000_000);
    expect(crashPoint(1_978_784_768)).toBe(179);
    const flight = { ...proofOf('high-flyer', [], () => undefined), steps: [{ nonce: 0, kind: 'act', status: 'ok' as const, draws: [{ n: 2 ** 32, v: 1_978_784_768 }], words: 1 }] };
    expect(checkOutcome({ ...flight, outcome: { detail: { crash: 1.79 } } }, null).errors).toEqual([]);
    expect(checkOutcome({ ...flight, outcome: { detail: { crash: 1.8 } } }, null).errors[0]).toMatch(/crash at 1.79x/);
    // No mapping: not checked, and never an error.
    expect(checkOutcome({ ...proofOf('bingo-ball', [], () => undefined), outcome: { detail: { x: 1 } } }, null)).toEqual({ checked: false, summary: null, errors: [] });
  });
});

/** Hands of the punto banco tableau from `from` up to the one that deals index endAt (the shoe's last). */
function tableauRounds(dealing: readonly string[], from: number, endAt = 364): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let at = from; ; ) {
    const n = baccaratHand(dealing.slice(at, at + 6))!.cards;
    out.push([at, at + n]);
    if (at <= endAt && endAt < at + n) return out;
    at += n;
  }
}

/** A complete shoe: chain of 3 links, shoe 2 at baccarat table 3, cut, burn and rounds like the engines deal. */
function shoeRecord(opts: { cut?: number; by?: 'player' | 'auto'; rounds?: Array<[number, number]>; status?: ShoeReveal['status'] } = {}) {
  const length = 3;
  const shoeNo = 2;
  const link = chainLink(SECRET, length, shoeNo);
  const inputs = { gameId: 'baccarat', table: 3, clientSeed: CS, shoeNo };
  const order = shoeOrder(link, inputs, 8).order;
  const salt = shoeSalt(link, inputs);
  const terminal = toHex(chainTerminal(SECRET, length));
  // Baccarat has 12 tables: the root has one line for each (the other chains do not matter here).
  const root = shoeRoot(Array.from({ length: 12 }, (_, i) => rootLine('baccarat', i + 1, i + 1 === 3 ? terminal : toHex(new Uint8Array(32).fill(i + 1)))));
  const kAuto = autoCut(inputs);
  const commit: ShoeCommit = {
    alg: ALG,
    shoe: 'sh_1',
    gameId: 'baccarat',
    table: 3,
    shoeNo,
    decks: 8,
    origin: { kind: 'chain', seedId: 's_test', chainId: 'c_1', index: shoeNo, prevLink: toHex(chainLink(SECRET, length, shoeNo - 1)), terminal, root: root.hash },
    clientSeed: CS,
    clientSeedBy: 'player',
    shoeHash: shoeHash(salt, order),
    cutRange: [CUT_MIN, CUT_MAX],
    cutPolicy: 'player',
    autoCut: kAuto,
    endAt: 364,
    burnRule: 'bac-value',
    at: 30,
  };
  const at = opts.cut ?? kAuto;
  const burn = burnOf('bac-value', rotate(order, at));
  const rounds = (opts.rounds ?? tableauRounds(rotate(order, at), burn.cards)).map(([a, b], i) => ({ roundId: `R-${i + 1}`, from: a, to: b }));
  const reveal: ShoeReveal = {
    shoe: 'sh_1',
    status: opts.status ?? 'ended',
    link: toHex(link),
    salt: toHex(salt),
    order: lettersOf(order),
    cut: { at, by: opts.by ?? 'auto' },
    burn,
    rounds,
    at: 40,
  };
  const pair: PairSeen = keptPair('baccarat', 's_test', { root });
  return { commit, reveal, lines: root.lines, order, pair, opts: { pair } };
}

describe('verifyShoe', () => {
  it('accepts a complete shoe and gives the dealing order; provable with the cut asked for and the hands seen', () => {
    const { commit, reveal, order, pair } = shoeRecord();
    const r = verifyShoe(commit, reveal, { pair, expectedCut: 'auto', hands: reveal.rounds });
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({ ok: true, provable: true, unproven: [] });
    expect(r.dealing).toEqual(rotate(order, commit.autoCut));
    // Without the player's own records of the shoe it checks out, but the cut and the hands are the server's word.
    expect(verifyShoe(commit, reveal, { pair })).toMatchObject({
      ok: true,
      provable: false,
      unproven: ['the cut the player asked for on this shoe is not given', 'the hands the player saw dealt from this shoe are not given'],
    });
  });

  it('needs the kept pair: without it the order could come from any chain and any client seed', () => {
    const { commit, reveal } = shoeRecord();
    expect(verifyShoe(commit, reveal, {} as never).errors.join()).toMatch(/no pair/);
    // A fresh chain whose terminal is in no published root fails, also when the root is looked up by the commitment's own root.
    const forged = shoeRecord();
    const fake = shoeRoot([rootLine('baccarat', 3, forged.commit.origin.terminal)]);
    expect(verifyShoe({ ...forged.commit, origin: { ...forged.commit.origin, root: fake.hash } }, forged.reveal, forged.opts).errors.join()).toMatch(/root/);
  });

  it('checks the pair it belongs to: seed id, root, client seed and the order of the times', () => {
    const { commit, reveal, pair } = shoeRecord();
    expect(verifyShoe(commit, reveal, { pair: { ...pair, seedId: 'other' } }).errors.join()).toMatch(/belongs to pair s_test/);
    expect(verifyShoe(commit, reveal, { pair: { ...pair, clientSeed: 'another-seed' } }).errors.join()).toMatch(/client seed is not the one of the pair/);
    expect(verifyShoe(commit, reveal, { pair: { ...pair, clientSeedAt: 10 } }).errors.join()).toMatch(/not set after the pair was shown/);
    expect(verifyShoe({ ...commit, at: 15 }, reveal, { pair }).errors.join()).toMatch(/opened before its client seed/);
  });

  it('a commitment under a server-picked client seed is not provable', () => {
    const { commit, reveal, opts } = shoeRecord();
    const r = verifyShoe({ ...commit, clientSeedBy: 'server' }, reveal, opts);
    expect(r).toMatchObject({ ok: false, provable: false });
    expect(r.errors).toEqual(['not provable: the server picked the client seed after its commitment']);
    expect(r.dealing).not.toBeNull();
  });

  it('accepts a player cut anywhere from 52 to 364 and rejects 51 and 365', () => {
    for (const cut of [52, 200, 364]) {
      const { commit, reveal, opts } = shoeRecord({ cut, by: 'player' });
      expect(verifyShoe(commit, reveal, opts).ok).toBe(true);
    }
    for (const cut of [51, 365]) {
      const { commit, reveal, opts } = shoeRecord({ cut, by: 'player' });
      expect(verifyShoe(commit, reveal, opts).errors.join()).toMatch(/outside 52 to 364/);
    }
  });

  it('an automatic or timed-out cut must be kAuto; the player can check the cut asked for', () => {
    const { commit, opts } = shoeRecord();
    const other = commit.autoCut === 200 ? 201 : 200;
    const { reveal } = shoeRecord({ cut: other, by: 'auto' });
    expect(verifyShoe(commit, reveal, opts).errors.join()).toMatch(/automatic cut/);
    const mine = shoeRecord({ cut: 180, by: 'player' });
    expect(verifyShoe(mine.commit, mine.reveal, { ...mine.opts, expectedCut: { at: 180 } }).ok).toBe(true);
    expect(verifyShoe(mine.commit, mine.reveal, { ...mine.opts, expectedCut: { at: 181 } }).errors.join()).toMatch(/player cut at 181/);
    expect(verifyShoe(mine.commit, mine.reveal, { ...mine.opts, expectedCut: 'auto' }).errors.join()).toMatch(/automatic cut/);
  });

  it('the rules are the published ones: another cut range, cut card, burn, deck count or cut policy fails', () => {
    const { commit, reveal, opts } = shoeRecord();
    expect(shoeRulesFor('baccarat')).toMatchObject({ cutRange: [52, 364], endAt: 364, burn: 'bac-value', cutPolicy: 'player' });
    expect(verifyShoe({ ...commit, cutRange: [0, 415], autoCut: autoCut({ gameId: 'baccarat', table: 3, clientSeed: CS, shoeNo: 2 }, 0, 415) }, { ...reveal, cut: null, burn: null, rounds: [], status: 'aborted' }, opts).errors.join()).toMatch(/breaks the rules: cut range 0 to 415/);
    expect(verifyShoe({ ...commit, endAt: 415 }, reveal, opts).errors.join()).toMatch(/cut card at 415/);
    expect(verifyShoe({ ...commit, burnRule: 'none' }, reveal, opts).errors.join()).toMatch(/burn none/);
    expect(verifyShoe({ ...commit, cutPolicy: 'auto' }, reveal, opts).errors.join()).toMatch(/cut policy auto/);
    // The rules are the pair's game's: a commitment that names another game fails, whatever that game's rules are.
    expect(verifyShoe({ ...commit, gameId: 'roulette' }, reveal, opts).errors.join()).toMatch(/the shoe is of roulette, the pair of baccarat/);
    expect(verifyShoe(commit, reveal, { pair: { ...opts.pair, gameId: 'roulette' } }).errors.join()).toMatch(/no published shoe rules for roulette/);
  });

  it('solo blackjack cuts automatically only: a cut claimed by the player fails', () => {
    const link = chainLink(SECRET, 3, 1);
    const inputs = { gameId: 'solo-classic', table: 1, clientSeed: CS, shoeNo: 1 };
    const order = shoeOrder(link, inputs, 8).order;
    const salt = shoeSalt(link, inputs);
    const terminal = toHex(chainTerminal(SECRET, 3));
    const root = shoeRoot([rootLine('solo-classic', 1, terminal)]);
    const k = autoCut(inputs);
    const commit: ShoeCommit = {
      alg: ALG,
      shoe: 'sh_bj',
      gameId: 'solo-classic',
      table: 1,
      shoeNo: 1,
      decks: 8,
      origin: { kind: 'chain', seedId: 's_bj', chainId: 'c_bj', index: 1, prevLink: terminal, terminal, root: root.hash },
      clientSeed: CS,
      clientSeedBy: 'player',
      shoeHash: shoeHash(salt, order),
      cutRange: [52, 364],
      cutPolicy: 'auto',
      autoCut: k,
      endAt: null,
      burnRule: 'none',
      at: 30,
    };
    const reveal: ShoeReveal = { shoe: 'sh_bj', status: 'ended', link: toHex(link), salt: toHex(salt), order: lettersOf(order), cut: { at: k, by: 'auto' }, burn: null, rounds: [{ roundId: 'R-1', from: 0, to: 6 }], at: 2 };
    const pair = keptPair('solo-classic', 's_bj', { root });
    expect(verifyShoe(commit, reveal, { pair }).ok).toBe(true);
    // The server knows O when it opens the solo shoe: a "player" cut at the k it likes must not pass.
    const chosen = k === 90 ? 91 : 90;
    expect(verifyShoe(commit, { ...reveal, cut: { at: chosen, by: 'player' } }, { pair }).errors.join()).toMatch(/cuts automatically only/);
  });

  it('reports a swapped card, a hex salt, a foreign link and a terminal missing from the root', () => {
    const { commit, reveal, lines, opts } = shoeRecord();
    const swapped = { ...reveal, order: reveal.order[1]! + reveal.order[0]! + reveal.order.slice(2) };
    expect(verifyShoe(commit, swapped, opts).errors.join()).toMatch(/not the shuffle/);
    const hexSalted = { ...commit, shoeHash: toHex(new Uint8Array(32)) };
    expect(verifyShoe(hexSalted, reveal, opts).errors.join()).toMatch(/shoe hash/);
    const foreign = { ...reveal, link: toHex(chainLink(SECRET, 3, 3)) };
    expect(verifyShoe(commit, foreign, opts).ok).toBe(false);
    expect(verifyShoe(commit, reveal, { pair: { ...opts.pair, root: shoeRoot(lines.slice(1)) } }).errors.join()).toMatch(/root/);
  });

  it('reports gaps, a round after the cut card, an early end and a burn off the rule', () => {
    const { commit, reveal, opts } = shoeRecord();
    const b = reveal.burn!.cards;
    expect(verifyShoe(commit, { ...reveal, rounds: [{ roundId: 'a', from: b + 1, to: 20 }] }, opts).errors.join()).toMatch(/do not follow/);
    expect(verifyShoe(commit, { ...reveal, rounds: [...reveal.rounds, { roundId: 'x', from: 367, to: 371 }] }, opts).errors.join()).toMatch(/after the round/);
    expect(verifyShoe(commit, { ...reveal, rounds: reveal.rounds.slice(0, 1) }, opts).errors.join()).toMatch(/ended before its cut card/);
    expect(verifyShoe(commit, { ...reveal, burn: { cards: reveal.burn!.cards + 1, shown: reveal.burn!.shown } }, opts).errors.join()).toMatch(/burn/);
    expect(verifyShoe(commit, { ...reveal, status: 'shuffled' }, opts).errors.join()).toMatch(/should have ended/);
    expect(verifyShoe(commit, { ...reveal, status: 'shuffled', rounds: reveal.rounds.slice(0, 1) }, opts).ok).toBe(true);
  });

  it('a malformed record gives errors, never an exception', () => {
    const { commit, reveal, opts } = shoeRecord();
    for (const bad of [{ ...commit, decks: 0 }, { ...commit, decks: 1.5 }, { ...commit, cutRange: [1] as unknown as [number, number] }, { ...commit, origin: null as never }, { ...commit, endAt: -1 }, { ...commit, table: '3' as unknown as number }]) {
      const r = verifyShoe(bad, reveal, opts);
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
    }
    expect(verifyShoe(commit, { ...reveal, order: reveal.order.slice(1) }, opts).errors.join()).toMatch(/416 cards/);
    expect(verifyShoe(null as never, reveal, opts).ok).toBe(false);
  });

  it('burn rules: a ten or a picture burns 10 more, an ace 1, blackjack one face down', () => {
    expect(burnOf('bac-value', ['10H', 'AS'])).toEqual({ cards: 11, shown: '10H' });
    expect(burnOf('bac-value', ['KD'])).toEqual({ cards: 11, shown: 'KD' });
    expect(burnOf('bac-value', ['AC'])).toEqual({ cards: 2, shown: 'AC' });
    expect(burnOf('bac-value', ['7S'])).toEqual({ cards: 8, shown: '7S' });
    expect(burnOf('bj-one-down', ['7S'])).toEqual({ cards: 1, shown: null });
    expect(burnOf('none', [])).toEqual({ cards: 0, shown: null });
  });
});

describe('verifyRound with shoes', () => {
  it('checks every slice against its verified shoe and the baccarat hand against the tableau', () => {
    const { commit, reveal, pair, order } = shoeRecord({ rounds: undefined });
    const d = rotate(order, commit.autoCut);
    const r = reveal.rounds[0]!;
    const hand = baccaratHand(d.slice(r.from, r.to))!;
    const detail = { table: 3, player: hand.player, banker: hand.banker, playerTotal: hand.playerTotal, bankerTotal: hand.bankerTotal, winner: hand.winner };
    const proof = proofOf('baccarat', [], () => undefined, { seedId: 's_test', serverSeed: SEED, shoes: [{ shoe: 'sh_1', table: 3, from: r.from, to: r.to }], outcome: { detail } });
    const shoes = [{ commit, reveal }];
    const own = { cuts: { sh_1: 'auto' as const }, hands: { sh_1: reveal.rounds }, tables: { 'R-1': 3 } };
    const ok = verifyRound(proof, SEED, { shoes, pairs: [pair], own });
    expect(ok.errors).toEqual([]);
    expect(ok).toMatchObject({ ok: true, provable: true });
    expect(ok.cards).toEqual([d.slice(r.from, r.to)]);
    expect(ok.outcome.checked).toBe(true);
    // Without the player's records: the cut, the hands and the table (12 tables) are the server's word.
    expect(verifyRound(proof, SEED, { shoes, pairs: [pair] })).toMatchObject({ ok: true, provable: false });
    expect(verifyRound(proof, SEED, { shoes, pairs: [pair], own: { ...own, tables: { 'R-1': 5 } } }).errors.join()).toMatch(/dealt at table 3, the player bet at table 5/);
    // The hand the proof claims must be the one the tableau deals from the shoe, with its totals and its winner.
    const claimed = { ...proof, outcome: { detail: { ...detail, player: hand.banker, banker: hand.player } } };
    expect(verifyRound(claimed, SEED, { shoes, pairs: [pair] }).errors.join()).toMatch(/outcome: the tableau deals/);
    const other = hand.winner === 'player' ? 'banker' : 'player';
    expect(verifyRound({ ...proof, outcome: { detail: { ...detail, winner: other } } }, SEED, { shoes, pairs: [pair] }).errors.join()).toMatch(new RegExp(`outcome: the winner is ${hand.winner}, the proof says "${other}"`));
    expect(verifyRound({ ...proof, outcome: { detail: { ...detail, table: 4 } } }, SEED, { shoes, pairs: [pair] }).errors.join()).toMatch(/the outcome names table 4/);
    // A slice that is no round of the shoe, the round of another id, another table, a shoe not given, a shoe still running.
    expect(verifyRound({ ...proof, shoes: [{ shoe: 'sh_1', table: 3, from: 999, to: 5 }] }, SEED, { shoes, pairs: [pair] }).ok).toBe(false);
    expect(verifyRound({ ...proof, roundId: 'R-2' }, SEED, { shoes, pairs: [pair] }).errors.join()).toMatch(/are round R-1, not R-2/);
    expect(verifyRound({ ...proof, shoes: [{ ...proof.shoes[0]!, table: 4 }] }, SEED, { shoes, pairs: [pair] }).errors.join()).toMatch(/at table 3, the round at table 4/);
    expect(verifyRound(proof, SEED, { pairs: [pair] }).errors.join()).toMatch(/shoe sh_1: record not given/);
    expect(verifyRound(proof, SEED, { shoes: [{ commit, reveal: null }], pairs: [pair] }).errors.join()).toMatch(/still running/);
    // The shoe's pair must be given as kept.
    expect(verifyRound(proof, SEED, { shoes }).errors.join()).toMatch(/pair s_test of its chain was not given/);
  });
});

/** A seed reveal of a kept pair, as the server would publish it. */
function revealOf(kept: PairSeen, serverSeed: string, lastNonce: number, lastShoes: SeedReveal['lastShoes'] = []): SeedReveal {
  const root = kept.root ? { hash: kept.root.hash, lines: [...kept.root.lines] } : null;
  return { seedId: kept.seedId, gameId: kept.gameId, serverSeed, serverSeedHash: serverSeedHash(serverSeed), clientSeed: kept.clientSeed, clientSeedBy: 'player', lastNonce, lastShoes, root, committedAt: kept.committedAt, clientSeedAt: kept.clientSeedAt, revealedAt: 9000 };
}

describe('seed reveal and pair', () => {
  const root = shoeRoot(['baccarat:1:' + 'cd'.repeat(32)]);
  const ok: SeedReveal = { seedId: 's', gameId: 'baccarat', serverSeed: SEED, serverSeedHash: serverSeedHash(SEED), clientSeed: CS, clientSeedBy: 'player', lastNonce: 4, lastShoes: [{ table: 1, shoeNo: 0 }], root, committedAt: 10, clientSeedAt: 11, revealedAt: 20 };

  it('checks the hash, the root, the last shoe numbers and that the player set the client seed after the commitment', () => {
    expect(verifySeedReveal(ok)).toEqual({ ok: true, errors: [] });
    expect(verifySeedReveal({ ...ok, clientSeedAt: 9 }).ok).toBe(false);
    // Equal times: the server could have seen the client seed before it committed.
    expect(verifySeedReveal({ ...ok, clientSeedAt: 10 }).ok).toBe(false);
    expect(verifySeedReveal({ ...ok, root: { ...root, lines: [] } }).ok).toBe(false);
    expect(verifySeedReveal({ ...ok, clientSeedBy: 'server' }).errors.join()).toMatch(NOT_PROVABLE);
    expect(verifySeedReveal({ ...ok, lastShoes: [] }).errors.join()).toMatch(/do not name the tables/);
    // An unused pair needs no client seed; a used one does.
    expect(verifySeedReveal({ ...ok, clientSeed: null, clientSeedBy: null, clientSeedAt: null, lastNonce: -1 }).ok).toBe(true);
    expect(verifySeedReveal({ ...ok, clientSeed: null, clientSeedBy: null, clientSeedAt: null }).errors.join()).toMatch(/without a client seed/);
  });

  it('verifyPair: every nonce in exactly one proof, a missing or doubled nonce shows, discarded steps are counted', () => {
    const kept = keptPair('craps');
    const pair = revealOf(kept, SEED, 2);
    const a = proofOf('craps', [0, 1], (r) => r.int(6), { id: 'p_a', serverSeed: SEED });
    a.steps[0]!.status = 'discarded';
    const b = proofOf('craps', [2], (r) => r.int(6), { id: 'p_b', serverSeed: SEED, roundId: 'R-2' });
    const all = verifyPair(pair, [a, b], [], { pair: kept });
    expect(all.errors).toEqual([]);
    expect(all.counts).toMatchObject({ proofs: 2, steps: 3, discarded: 1, shoes: 0 });
    expect(verifyPair(pair, [a], [], { pair: kept }).errors).toEqual(['nonce 2 is in no proof']);
    expect(verifyPair(pair, [a, b, { ...b, id: 'p_c' }], [], { pair: kept }).errors).toEqual(['nonce 2 is in 2 proofs']);
    expect(verifyPair({ ...pair, lastNonce: 1 }, [a, b], [], { pair: kept }).errors).toEqual(['nonce 2 is outside 0 to 1']);
    // Without the kept pair nothing binds the reveal.
    expect(verifyPair(pair, [a, b], [], {} as never).errors.join()).toMatch(/no pair/);
  });

  it("verifyPair: the player's own records show what the server leaves out at the end", () => {
    const kept = keptPair('craps');
    const a = proofOf('craps', [0, 1], (r) => r.int(6), { id: 'p_a', serverSeed: SEED });
    // The server drops nonce 2 and its proof, and says the last nonce was 1.
    const cut = revealOf(kept, SEED, 1);
    expect(verifyPair(cut, [a], [], { pair: kept }).ok).toBe(true);
    expect(verifyPair(cut, [a], [], { pair: kept, own: { nonce: 3 } }).errors.join()).toMatch(/nonces 0 to 2 were spent before the rotation, the reveal says 0 to 1/);
    expect(verifyPair(cut, [a], [], { pair: kept, own: { proofs: ['p_a', 'p_b'] } }).errors).toEqual(['proof p_b: received by the player, not on record']);
    expect(verifyPair(cut, [a], [], { pair: kept, own: { proofs: ['p_a'], nonce: 2, shoes: [] } }).ok).toBe(true);
  });

  it('verifyPair: the shoes of a table are numbered 1 to the last shoe number of the reveal, without a gap', () => {
    const one = shoeRecord();
    const last = (no: number) => Array.from({ length: 12 }, (_, i) => ({ table: i + 1, shoeNo: i + 1 === 3 ? no : 0 }));
    const pair = revealOf(one.pair, SEED, -1, last(2));
    const shoe0 = { commit: { ...one.commit, shoe: 'sh_0', shoeNo: 1, origin: { ...one.commit.origin, index: 1 } }, reveal: null };
    // Rounds without proofs would be refused (a round of the pair is in a proof): this shoe was shuffled before a hand.
    one.reveal = { ...one.reveal, status: 'shuffled', rounds: [] };
    // Shoe 2 alone: shoe 1 of that table is missing.
    expect(verifyPair(pair, [], [{ commit: one.commit, reveal: one.reveal }], { pair: one.pair }).errors.join()).toMatch(/table 3: shoes 1 to 2 expected, found 2/);
    const running = verifyPair(pair, [], [shoe0, { commit: one.commit, reveal: one.reveal }], { pair: one.pair });
    expect(running.errors).toEqual([]);
    expect(running.counts).toMatchObject({ shoes: 2, running: 1, shuffled: 1 });
    // A shoe taken after the last one listed (left out at the end) shows against the reveal's last number.
    expect(verifyPair(revealOf(one.pair, SEED, -1, last(3)), [], [shoe0, { commit: one.commit, reveal: one.reveal }], { pair: one.pair }).errors.join()).toMatch(/shoes 1 to 3 expected, found 1, 2/);
  });
});

// ------------------------------------------------------------------------------------------------ a cheating server
// Records that are consistent in themselves, built by a server that changed something after the player's client seed
// (SPEC.md section 8). Each must fail against the pair the player kept.

/** A consistent shoe of any game on a chain of 3 links. */
function anyShoe(o: { gameId: string; table: number; shoeNo: number; secret: Uint8Array; seedId: string; root: { hash: string }; cs?: string; cut?: { at: number; by: 'player' | 'auto' }; rounds: Array<[string | null, number]>; status: ShoeReveal['status']; shoe: string; at?: number }) {
  const rules = shoeRulesFor(o.gameId)!;
  const cs = o.cs ?? CS;
  const link = chainLink(o.secret, 3, o.shoeNo);
  const inputs = { gameId: o.gameId, table: o.table, clientSeed: cs, shoeNo: o.shoeNo };
  const order = shoeOrder(link, inputs, 8).order;
  const salt = shoeSalt(link, inputs);
  const k = autoCut(inputs, rules.cutRange[0], rules.cutRange[1]);
  const cut = o.cut ?? { at: k, by: 'auto' as const };
  const dealing = rotate(order, cut.at);
  const burn = rules.burn === 'none' ? null : burnOf(rules.burn, dealing);
  let next = burn ? burn.cards : 0;
  const rounds = o.rounds.map(([roundId, n]) => {
    const r = { roundId, from: next, to: next + n };
    next += n;
    return r;
  });
  const commit: ShoeCommit = {
    alg: ALG,
    shoe: o.shoe,
    gameId: o.gameId,
    table: o.table,
    shoeNo: o.shoeNo,
    decks: 8,
    origin: { kind: 'chain', seedId: o.seedId, chainId: 'c_x', index: o.shoeNo, prevLink: toHex(chainLink(o.secret, 3, o.shoeNo - 1)), terminal: toHex(chainTerminal(o.secret, 3)), root: o.root.hash },
    clientSeed: cs,
    clientSeedBy: 'player',
    shoeHash: shoeHash(salt, order),
    cutRange: [rules.cutRange[0], rules.cutRange[1]],
    cutPolicy: rules.cutPolicy,
    autoCut: k,
    endAt: rules.endAt,
    burnRule: rules.burn,
    at: o.at ?? 30,
  };
  const reveal: ShoeReveal = { shoe: o.shoe, status: o.status, link: toHex(link), salt: toHex(salt), order: lettersOf(order), cut, burn, rounds, at: 40 };
  return { record: { commit, reveal }, dealing };
}

const secretOf = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const DT_RANK: Record<string, number> = { A: 1, J: 11, Q: 12, K: 13 };
/** The outcome detail of a Dragon Tiger hand as the engine states it (ace low, an identical card is suited). */
const dtDetail = (dragon: string, tiger: string) => {
  const r = (c: string) => DT_RANK[c.slice(0, -1)] ?? Number(c.slice(0, -1));
  return { cards: { dragon, tiger }, winner: r(dragon) > r(tiger) ? 'dragon' : r(tiger) > r(dragon) ? 'tiger' : 'tie', suited: dragon === tiger };
};
const lineOf = (gameId: string, table: number, secret: Uint8Array): string => rootLine(gameId, table, toHex(chainTerminal(secret, 3)));
const rouletteOutcome = (pocket: number) => ({ result: { kind: 'number', n: pocket }, detail: { wheel: 'single', pocket, strikes: [] } });

describe('a cheating server', () => {
  it('A: a server seed swapped after the client seed (picked for pocket 0) fails against the kept hash', () => {
    const kept = keptPair('roulette', 'sd_A');
    let other = '';
    for (let i = 1; !other; i++) {
      const s = toHex(secretOf(i));
      if (roundRng(s, 'roulette', CS, 0).int(37) === 0) other = s;
    }
    const r = roundRng(other, 'roulette', CS, 0);
    r.int(37);
    const p = { ...proofOf('roulette', [], () => undefined), seedId: 'sd_A', serverSeedHash: serverSeedHash(other), serverSeed: other, steps: [{ nonce: 0, kind: 'act', status: 'ok' as const, draws: r.draws.slice(), words: r.words }], outcome: rouletteOutcome(0) };
    expect(verifyRound(p, other)).toMatchObject({ ok: true, provable: false });
    const check = verifyRound(p, other, { pair: kept });
    expect(check).toMatchObject({ ok: false, provable: false });
    expect(check.errors.join()).toMatch(/another server seed hash than the pair kept/);
    const seed = revealOf({ ...kept, serverSeedHash: serverSeedHash(other) }, other, 0);
    expect(verifySeedReveal(seed).ok).toBe(true);
    expect(verifyPair(seed, [p], [], { pair: kept }).errors.join()).toMatch(/pair: the reveal has another server seed hash/);
  });

  it('B: a client seed swapped and still called the player\'s fails against the seed sent', () => {
    const kept = keptPair('roulette', 'sd_B');
    let cs = '';
    for (let i = 0; !cs; i++) if (roundRng(SEED, 'roulette', `x${i}`, 0).int(37) === 0) cs = `x${i}`;
    const r = roundRng(SEED, 'roulette', cs, 0);
    r.int(37);
    const p = { ...proofOf('roulette', [], () => undefined), seedId: 'sd_B', clientSeed: cs, serverSeed: SEED, steps: [{ nonce: 0, kind: 'act', status: 'ok' as const, draws: r.draws.slice(), words: r.words }], outcome: rouletteOutcome(0) };
    expect(verifyRound(p, SEED, { pair: kept }).errors.join()).toMatch(/another client seed than the one sent/);
    expect(verifyPair({ ...revealOf(kept, SEED, 0), clientSeed: cs }, [p], [], { pair: kept }).errors.join()).toMatch(/pair: the reveal has another client seed/);
  });

  it('C: a new chain and root after the client seed fail for the shoe, the round and the pair', () => {
    const good = secretOf(0x20);
    const kept = keptPair('dragon-tiger', 'sd_C', { root: shoeRoot([lineOf('dragon-tiger', 1, good)]) });
    const evil = secretOf(0x66);
    const evilRoot = shoeRoot([lineOf('dragon-tiger', 1, evil)]);
    const s = anyShoe({ gameId: 'dragon-tiger', table: 1, shoeNo: 1, secret: evil, seedId: 'sd_C', root: evilRoot, cut: { at: 200, by: 'player' }, rounds: [['R-1', 2]], status: 'shuffled', shoe: 'sh_C' });
    const [from, to] = [s.record.reveal.rounds[0]!.from, s.record.reveal.rounds[0]!.to];
    const p = proofOf('dragon-tiger', [], () => undefined, { seedId: 'sd_C', serverSeed: SEED, shoes: [{ shoe: 'sh_C', table: 1, from, to }], outcome: { detail: { cards: { dragon: s.dealing[from], tiger: s.dealing[from + 1] } } } });
    const shoe = verifyShoe(s.record.commit, s.record.reveal, { pair: kept, expectedCut: { at: 200 } });
    expect(shoe).toMatchObject({ ok: false, provable: false });
    expect(shoe.errors.join()).toMatch(/the root is not the one of the pair/);
    expect(verifyRound(p, SEED, { pair: kept, shoes: [s.record] })).toMatchObject({ ok: false, provable: false });
    const pair = verifyPair({ ...revealOf(kept, SEED, -1, [{ table: 1, shoeNo: 1 }]), root: evilRoot }, [p], [s.record], { pair: kept });
    expect(pair.errors.join()).toMatch(/revealed root is not the one kept/);
    expect(pair.errors.join()).toMatch(/shoe sh_C: the root is not the one of the pair/);
  });

  it("D: a solo blackjack round from a shoe called baccarat (player's cut picked by the server) fails", () => {
    const solo = secretOf(0x21);
    const extra = secretOf(0x77);
    const root = shoeRoot([lineOf('solo-classic', 1, solo), lineOf('baccarat', 1, extra)]);
    const kept = keptPair('solo-classic', 'sd_D', { root });
    const s = anyShoe({ gameId: 'baccarat', table: 1, shoeNo: 1, secret: extra, seedId: 'sd_D', root, cut: { at: 77, by: 'player' }, rounds: [['R-1', 6]], status: 'shuffled', shoe: 'sh_D' });
    const r = s.record.reveal.rounds[0]!;
    const p = proofOf('solo-classic', [0], (x) => x.int(2 ** 32), { seedId: 'sd_D', serverSeed: SEED, shoes: [{ shoe: 'sh_D', table: 1, from: r.from, to: r.to }], outcome: { roundId: 'R-1', cards: s.dealing.slice(r.from, r.to) } });
    const shoe = verifyShoe(s.record.commit, s.record.reveal, { pair: kept });
    expect(shoe.errors.join()).toMatch(/the shoe is of baccarat, the pair of solo-classic/);
    expect(shoe.errors.join()).toMatch(/root line baccarat:1:.* is not one of solo-classic tables 1 to 1/);
    expect(verifyRound(p, SEED, { pair: kept, shoes: [s.record] }).errors.join()).toMatch(/shoe sh_D is of baccarat, the round of solo-classic/);
    expect(verifyPair(revealOf(kept, SEED, 0, [{ table: 1, shoeNo: 0 }]), [p], [s.record], { pair: kept }).ok).toBe(false);
  });

  it('E: a solo pair with twenty chains (the server picks the table per round) fails', () => {
    const secrets = Array.from({ length: 20 }, (_, i) => secretOf(0x30 + i));
    const root = shoeRoot(secrets.map((x, i) => lineOf('solo-classic', i + 1, x)));
    const kept = keptPair('solo-classic', 'sd_E', { root });
    const s = anyShoe({ gameId: 'solo-classic', table: 13, shoeNo: 1, secret: secrets[12]!, seedId: 'sd_E', root, rounds: [['R-1', 6]], status: 'ended', shoe: 'sh_E' });
    const check = verifyShoe(s.record.commit, s.record.reveal, { pair: kept, expectedCut: 'auto' });
    expect(check.ok).toBe(false);
    expect(check.errors.join()).toMatch(/solo-classic:13:.* is not one of solo-classic tables 1 to 1/);
  });

  it('F, F2, G: draws before the spin, a second spin, draws before the flight: the draw plan refuses them', () => {
    const kept = keptPair('roulette');
    const honest = roundRng(SEED, 'roulette', CS, 0).int(37);
    let pad = 1;
    const padded = (j: number, n: number) => {
      const r = roundRng(SEED, kept.gameId, CS, 0);
      for (let i = 0; i < j; i++) r.int(2);
      const v = r.int(n);
      return { v, step: { nonce: 0, kind: 'act', status: 'ok' as const, draws: r.draws.slice(), words: r.words } };
    };
    while (padded(pad, 37).v !== 0) pad++;
    expect(honest).not.toBe(0);
    const f = { ...proofOf('roulette', [], () => undefined), steps: [padded(pad, 37).step], outcome: rouletteOutcome(0) };
    expect(verifyRound(f, SEED, { pair: kept }).errors.join()).toMatch(/outcome: the spin draws int\(37\), the step drew int\(2\)/);
    const two = roundRng(SEED, 'roulette', CS, 0);
    two.int(37);
    const second = two.int(37);
    const f2 = { ...proofOf('roulette', [], () => undefined), steps: [{ nonce: 0, kind: 'act', status: 'ok' as const, draws: two.draws.slice(), words: two.words }], outcome: rouletteOutcome(second) };
    expect(verifyRound(f2, SEED, { pair: kept })).toMatchObject({ ok: false, outcome: { checked: true } });
    // Two applied steps that both spin.
    const twoSteps = proofOf('roulette', [0, 1], (r) => r.int(37));
    expect(verifyRound({ ...twoSteps, outcome: rouletteOutcome(twoSteps.steps[1]!.draws[0]!.v) }, SEED, { pair: kept }).errors.join()).toMatch(/2 steps drew/);
    // High Flyer: one filler draw before the flight gives a lower crash.
    const hf = keptPair('high-flyer');
    const r = roundRng(SEED, 'high-flyer', CS, 0);
    r.int(2);
    const low = crashPoint(r.int(2 ** 32));
    const g = { ...proofOf('high-flyer', [], () => undefined), steps: [{ nonce: 0, kind: 'act', status: 'ok' as const, draws: r.draws.slice(), words: r.words }], outcome: { detail: { crash: low / 100 } } };
    expect(verifyRound(g, SEED, { pair: hf }).errors.join()).toMatch(/the flight draws int\(2\^32\), the step drew int\(2\), int\(2\^32\)/);
    // The honest records pass.
    const honestSpin = proofOf('roulette', [0], (x) => x.int(37));
    expect(verifyRound({ ...honestSpin, outcome: rouletteOutcome(honest) }, SEED, { pair: kept })).toMatchObject({ ok: true, provable: true, outcome: { checked: true } });
  });

  it('H: a card game round without its shoe slice fails; a multiplier variant is never called checked', () => {
    const kept = keptPair('baccarat');
    const h = proofOf('baccarat', [], () => undefined, { outcome: { detail: { player: ['KS', 'QS'], banker: ['9H', 'KH'] } } });
    expect(verifyRound(h, SEED, { pair: kept }).errors.join()).toMatch(/no shoe slice/);
    const gold = keptPair('gold-baccarat');
    expect(verifyRound({ ...h, gameId: 'gold-baccarat' }, SEED, { pair: gold }).errors.join()).toMatch(/no shoe slice/);
    // A solo blackjack round too (each is dealt from its own shoe): without the slice it is not provable.
    const bj = proofOf('solo-classic', [], () => undefined, { outcome: { roundId: 'R-1', cards: ['AS', 'KS'] } });
    expect(verifyRound(bj, SEED, { pair: keptPair('solo-classic') })).toMatchObject({ ok: false, provable: false });
    // Multiplier Roulette draws its strikes first: not mapped, so not checked (and the last int(37) proves nothing).
    const multi = proofOf('blitz-roulette', [0], (x) => (x.int(5), x.int(37)));
    expect(verifyRound({ ...multi, outcome: rouletteOutcome(multi.steps[0]!.draws[1]!.v) }, SEED, { pair: keptPair('blitz-roulette') }).outcome.checked).toBe(false);
  });

  it('I: shoes left out at the end of the chain show against the reveal and the commitments the player received', () => {
    const secret = secretOf(0x20);
    const root = shoeRoot([lineOf('dragon-tiger', 1, secret)]);
    const kept = keptPair('dragon-tiger', 'sd_I', { root });
    const s1 = anyShoe({ gameId: 'dragon-tiger', table: 1, shoeNo: 1, secret, seedId: 'sd_I', root, cut: { at: 200, by: 'player' }, rounds: [], status: 'shuffled', shoe: 'sh_I1' });
    // The server is honest about the last shoe number...
    expect(verifyPair(revealOf(kept, SEED, -1, [{ table: 1, shoeNo: 3 }]), [], [s1.record], { pair: kept }).errors.join()).toMatch(/shoes 1 to 3 expected, found 1/);
    // ...or not: then the commitments the player received give it away.
    const lying = revealOf(kept, SEED, -1, [{ table: 1, shoeNo: 1 }]);
    expect(verifyPair(lying, [], [s1.record], { pair: kept })).toMatchObject({ ok: true, counts: { aborted: 0 } });
    expect(verifyPair(lying, [], [s1.record], { pair: kept, own: { shoes: ['sh_I1', 'sh_I2'] } }).errors).toEqual(['shoe sh_I2: its commitment was received by the player, not on record']);
  });

  it('I2: a shoe of the old chain committed after its pair was revealed is refused', () => {
    const secret = secretOf(0x20);
    const root = shoeRoot([lineOf('dragon-tiger', 1, secret)]);
    const old = { ...keptPair('dragon-tiger', 'sd_I', { root }), revealedAt: 9000 };
    const s3 = anyShoe({ gameId: 'dragon-tiger', table: 1, shoeNo: 3, secret, seedId: 'sd_I', root, cut: { at: 100, by: 'player' }, rounds: [['R-9', 2]], status: 'shuffled', shoe: 'sh_I3', at: 9500 });
    const r = s3.record.reveal.rounds[0]!;
    // The new pair has a fresh client seed of its own (the same seed sent again would be refused, test S).
    const fresh = keptPair('dragon-tiger', 'sd_I2', { committedAt: 9000, clientSeed: 'fresh-seed', clientSeedAt: 9100, root: shoeRoot([lineOf('dragon-tiger', 1, secretOf(0x21))]) });
    const p = proofOf('dragon-tiger', [], () => undefined, { seedId: 'sd_I2', clientSeed: 'fresh-seed', roundId: 'R-9', shoes: [{ shoe: 'sh_I3', table: 1, from: r.from, to: r.to }], outcome: { detail: dtDetail(s3.dealing[r.from]!, s3.dealing[r.from + 1]!) } });
    const own = { cuts: { sh_I3: { at: 100 } }, hands: { sh_I3: s3.record.reveal.rounds } };
    expect(verifyRound(p, SEED, { pair: fresh, shoes: [s3.record], pairs: [old], own }).errors.join()).toMatch(/committed at 9500, after its pair was revealed at 9000/);
    const later = { ...old, revealedAt: 9600, lastShoes: [{ table: 1, shoeNo: 3 }] };
    expect(verifyRound(p, SEED, { pair: fresh, shoes: [s3.record], pairs: [later], own })).toMatchObject({ ok: true, provable: true, outcome: { checked: true } });
    // Without the reveal received at the rotation the old chain's last shoe is the server's word: not provable.
    expect(verifyRound(p, SEED, { pair: fresh, shoes: [s3.record], pairs: [{ ...later, lastShoes: undefined }], own })).toMatchObject({ ok: true, provable: false });
    // A shoe beyond the last one the reveal named (its `at` is only the server's claim) is refused.
    expect(verifyRound(p, SEED, { pair: fresh, shoes: [s3.record], pairs: [{ ...later, lastShoes: [{ table: 1, shoeNo: 2 }] }], own }).errors.join()).toMatch(/shoe 3 of table 1 of pair sd_I, whose reveal ended that chain at shoe 2/);
    // Three shoes of the old chain still in play at its reveal: one more than the running one and one committed ahead.
    const inPlay = [1, 2, 3].map((no) => anyShoe({ gameId: 'dragon-tiger', table: 1, shoeNo: no, secret, seedId: 'sd_I', root, rounds: [], status: 'shuffled', shoe: `sh_P${no}` }).record);
    const running = inPlay.map((x) => ({ commit: x.commit, reveal: null }));
    const seed = revealOf(old, SEED, -1, [{ table: 1, shoeNo: 3 }]);
    expect(verifyPair(seed, [], running, { pair: old }).errors.join()).toMatch(/3 shoes of the pair were still in play at its reveal/);
    expect(verifyPair(seed, [], [inPlay[0]!, ...running.slice(1)], { pair: old }).ok).toBe(true);
  });

  it('P: the root lines alone are not enough: a client seed ground per shoe fails against the pair', () => {
    const secret = secretOf(0x20);
    const root = shoeRoot([lineOf('dragon-tiger', 1, secret)]);
    const kept = keptPair('dragon-tiger', 'sd_P', { root });
    const s = anyShoe({ gameId: 'dragon-tiger', table: 1, shoeNo: 1, secret, seedId: 'sd_P', root, cs: 'g7', cut: { at: 200, by: 'player' }, rounds: [['R-1', 2]], status: 'shuffled', shoe: 'sh_P' });
    expect(verifyShoe(s.record.commit, s.record.reveal, { rootLines: root.lines, expectedCut: { at: 200 } } as never).errors.join()).toMatch(/no pair/);
    const check = verifyShoe(s.record.commit, s.record.reveal, { pair: kept, expectedCut: { at: 200 } });
    expect(check).toMatchObject({ ok: false, provable: false });
    expect(check.errors).toContain('the client seed is not the one of the pair');
  });

  it('every round a shoe lists under a proof\'s id is in that proof', () => {
    const secret = secretOf(0x20);
    const root = shoeRoot([lineOf('dragon-tiger', 1, secret)]);
    const kept = keptPair('dragon-tiger', 'sd_R', { root });
    const s = anyShoe({ gameId: 'dragon-tiger', table: 1, shoeNo: 1, secret, seedId: 'sd_R', root, cut: { at: 200, by: 'player' }, rounds: [['R-1', 2], ['R-1', 2]], status: 'shuffled', shoe: 'sh_R' });
    const r = s.record.reveal.rounds[1]!;
    // The second hand the shoe lists under R-1 is the one the proof claims; the first is left out.
    const p = proofOf('dragon-tiger', [], () => undefined, { id: 'p_R', seedId: 'sd_R', shoes: [{ shoe: 'sh_R', table: 1, from: r.from, to: r.to }], outcome: { detail: { cards: { dragon: s.dealing[r.from], tiger: s.dealing[r.from + 1] } } } });
    expect(verifyPair(revealOf(kept, SEED, -1, [{ table: 1, shoeNo: 1 }]), [p], [s.record], { pair: kept }).errors.join()).toMatch(/proof p_R: shoe sh_R dealt cards \d+ to \d+ to round R-1, the proof does not list them/);
  });
});

// ------------------------------------------------------------------------------- the player's own records and the card rules
// A server that knows every order it committed: it deals hands nobody asked for, deals the player's hand at another
// table, writes a winner the cards do not give, drops the outcome to switch the draw plan off, takes a shoe of an old
// chain past its reveal or a client seed it knew before. Each must fail against the rules or the player's own records.

describe('a server that knows the order', () => {
  const dtPair = (seedId: string, byte = 0x20) => {
    const secret = secretOf(byte);
    const root = shoeRoot([lineOf('dragon-tiger', 1, secret)]);
    return { secret, root, kept: keptPair('dragon-tiger', seedId, { root }) };
  };
  const dtProof = (id: string, seedId: string, roundId: string, shoe: string, r: { from: number; to: number }, dealing: readonly string[]) =>
    proofOf('dragon-tiger', [], () => undefined, { id, seedId, roundId, shoes: [{ shoe, table: 1, from: r.from, to: r.to }], outcome: { detail: dtDetail(dealing[r.from]!, dealing[r.from + 1]!) } });

  it('J: free hands the player never asked for (cards skipped) fail against the hands it saw; free hands are counted', () => {
    const { secret, root, kept } = dtPair('sd_J');
    // The player played two hands, R-1 and R-2. The server slipped a free hand in between and so chose R-2's cards.
    const s = anyShoe({ gameId: 'dragon-tiger', table: 1, shoeNo: 1, secret, seedId: 'sd_J', root, cut: { at: 200, by: 'player' }, rounds: [['R-1', 2], [null, 2], ['R-2', 2]], status: 'shuffled', shoe: 'sh_J' });
    const [r1, , r2] = s.record.reveal.rounds;
    const seen = [
      { roundId: 'R-1', from: r1!.from, to: r1!.to },
      { roundId: 'R-2', from: r1!.to, to: r1!.to + 2 },
    ];
    const check = verifyShoe(s.record.commit, s.record.reveal, { pair: kept, expectedCut: { at: 200 }, hands: seen });
    expect(check.ok).toBe(false);
    expect(check.errors.join()).toMatch(/the shoe lists round R-1 \d+-\d+, free hand \d+-\d+, round R-2 \d+-\d+; the player saw round R-1 \d+-\d+, round R-2 \d+-\d+/);
    // Without the hands the player saw, the records are consistent: ok, but not provable.
    expect(verifyShoe(s.record.commit, s.record.reveal, { pair: kept, expectedCut: { at: 200 } })).toMatchObject({ ok: true, provable: false });
    const proofs = [dtProof('p_J1', 'sd_J', 'R-1', 'sh_J', r1!, s.dealing), dtProof('p_J2', 'sd_J', 'R-2', 'sh_J', r2!, s.dealing)];
    const reveal = revealOf(kept, SEED, -1, [{ table: 1, shoeNo: 1 }]);
    const own = { proofs: ['p_J1', 'p_J2'], shoes: ['sh_J'], nonce: 0, cuts: { sh_J: { at: 200 } } };
    const blind = verifyPair(reveal, proofs, [s.record], { pair: kept, own });
    expect(blind).toMatchObject({ ok: true, provable: false, counts: { free: 1 } });
    expect(blind.unproven!.join()).toMatch(/hands the player saw/);
    expect(verifyPair(reveal, proofs, [s.record], { pair: kept, own: { ...own, hands: { sh_J: seen } } }).errors.join()).toMatch(/shoe sh_J: the shoe lists .*free hand/);
    for (const p of proofs) expect(verifyRound(p, SEED, { pair: kept, shoes: [s.record], own: { ...own, hands: { sh_J: seen } } }).ok).toBe(false);
    // The honest shoe and the hands seen agree: provable.
    const honest = anyShoe({ gameId: 'dragon-tiger', table: 1, shoeNo: 1, secret, seedId: 'sd_J', root, cut: { at: 200, by: 'player' }, rounds: [['R-1', 2], ['R-2', 2]], status: 'shuffled', shoe: 'sh_J' });
    const hp = honest.record.reveal.rounds.map((r, i) => dtProof(`p_J${i + 1}`, 'sd_J', r.roundId!, 'sh_J', r, honest.dealing));
    expect(verifyPair(reveal, hp, [honest.record], { pair: kept, own: { ...own, hands: { sh_J: honest.record.reveal.rounds } } })).toMatchObject({ ok: true, provable: true, counts: { free: 0 } });
  });

  it('J2: a hand longer than the rules (a free hand of four Dragon Tiger cards) fails even without the hands seen', () => {
    const { secret, root, kept } = dtPair('sd_J2');
    const s = anyShoe({ gameId: 'dragon-tiger', table: 1, shoeNo: 1, secret, seedId: 'sd_J2', root, cut: { at: 200, by: 'player' }, rounds: [[null, 4], ['R-1', 2]], status: 'shuffled', shoe: 'sh_J2' });
    expect(verifyShoe(s.record.commit, s.record.reveal, { pair: kept }).errors.join()).toMatch(/the free hand at cards \d+ to \d+ takes 4 cards, a hand of dragon-tiger takes 2 there/);
  });

  it('K: a ghost round (a round id without a proof) fails verifyPair', () => {
    const { secret, root, kept } = dtPair('sd_K');
    const s = anyShoe({ gameId: 'dragon-tiger', table: 1, shoeNo: 1, secret, seedId: 'sd_K', root, cut: { at: 200, by: 'player' }, rounds: [['R-ghost', 2], ['R-1', 2]], status: 'shuffled', shoe: 'sh_K' });
    const p = dtProof('p_K', 'sd_K', 'R-1', 'sh_K', s.record.reveal.rounds[1]!, s.dealing);
    const reveal = revealOf(kept, SEED, -1, [{ table: 1, shoeNo: 1 }]);
    expect(verifyPair(reveal, [p], [s.record], { pair: kept }).errors).toContain(`shoe sh_K dealt cards ${s.record.reveal.rounds[0]!.from} to ${s.record.reveal.rounds[0]!.to} to round R-ghost, which is in no proof given`);
    // A round of a later pair dealt from this pair's shoe after the rotation is fine once its proof is given.
    const later = { ...dtProof('p_K9', 'sd_K9', 'R-ghost', 'sh_K', s.record.reveal.rounds[0]!, s.dealing) };
    expect(verifyPair(reveal, [p], [s.record], { pair: kept, later: [later] }).ok).toBe(true);
  });

  it('L: a solo blackjack shoe for one round holds that round only: no free hand, no second round, no shoe of an earlier pair', () => {
    const secret = secretOf(0x41);
    const root = shoeRoot([lineOf('solo-classic', 1, secret)]);
    const kept = keptPair('solo-classic', 'sd_L', { root });
    const one = anyShoe({ gameId: 'solo-classic', table: 1, shoeNo: 1, secret, seedId: 'sd_L', root, rounds: [['R-1', 6]], status: 'ended', shoe: 'sh_L' });
    expect(verifyShoe(one.record.commit, one.record.reveal, { pair: kept })).toMatchObject({ ok: true, provable: true });
    const skipped = anyShoe({ gameId: 'solo-classic', table: 1, shoeNo: 1, secret, seedId: 'sd_L', root, rounds: [[null, 7], ['R-1', 6]], status: 'ended', shoe: 'sh_L' });
    expect(verifyShoe(skipped.record.commit, skipped.record.reveal, { pair: kept }).errors).toEqual(['a shoe for one round lists 2 rounds', 'a shoe for one round lists a hand outside a round']);
    const two = anyShoe({ gameId: 'solo-classic', table: 1, shoeNo: 1, secret, seedId: 'sd_L', root, rounds: [['R-1', 6], ['R-2', 6]], status: 'ended', shoe: 'sh_L' });
    expect(verifyShoe(two.record.commit, two.record.reveal, { pair: kept }).errors).toEqual(['a shoe for one round lists 2 rounds']);
    expect(verifyShoe(one.record.commit, { ...one.record.reveal, rounds: [] }, { pair: kept }).errors).toEqual(['a shoe for one round ended without its round']);
    // A round of a later pair from this pair's shoe: refused for a game that deals each round from its own shoe.
    const next = keptPair('solo-classic', 'sd_L2', { clientSeed: 'next-seed', root: shoeRoot([lineOf('solo-classic', 1, secretOf(0x42))]) });
    const r = one.record.reveal.rounds[0]!;
    const p = proofOf('solo-classic', [], () => undefined, { seedId: 'sd_L2', clientSeed: 'next-seed', shoes: [{ shoe: 'sh_L', table: 1, from: r.from, to: r.to }], outcome: { roundId: 'R-1' } });
    expect(verifyRound(p, SEED, { pair: next, shoes: [one.record], pairs: [{ ...kept, revealedAt: 9000, lastShoes: [{ table: 1, shoeNo: 1 }] }] }).errors.join()).toMatch(/every round of solo-classic is dealt from a shoe of its own pair/);
  });

  it('M: baccarat against the tableau: a hand dealt against the third-card rule and a winner the cards do not give fail', () => {
    const { commit, reveal, pair, order } = shoeRecord();
    const d = rotate(order, commit.autoCut);
    const r = reveal.rounds[0]!;
    const hand = baccaratHand(d.slice(r.from, r.from + 6))!;
    // One card more or less than the tableau takes: the shoe and the proof both fail.
    const n = hand.cards === 6 ? 5 : hand.cards + 1;
    const wrong = { ...reveal, rounds: [{ roundId: 'R-1', from: r.from, to: r.from + n }, ...tableauRounds(d, r.from + n).map(([a, b], i) => ({ roundId: `R-${i + 2}`, from: a, to: b }))] };
    expect(verifyShoe(commit, wrong, { pair }).errors.join()).toMatch(new RegExp(`round R-1 at cards ${r.from} to ${r.from + n} takes ${n} cards, a hand of baccarat takes ${hand.cards} there`));
    const cards = d.slice(r.from, r.from + n);
    const proof = proofOf('baccarat', [], () => undefined, { serverSeed: SEED, shoes: [{ shoe: 'sh_1', table: 3, from: r.from, to: r.from + n }], outcome: { detail: { table: 3, player: [cards[0], cards[2]], banker: [cards[1], cards[3]], playerTotal: 0, bankerTotal: 0, winner: 'banker' } } });
    expect(verifyRound(proof, SEED, { shoes: [{ commit, reveal: wrong }], pairs: [pair] }).errors.join()).toMatch(/outcome: the tableau takes (more than )?\d cards here, the shoe dealt \d/);
    // Dragon Tiger: the cards are right, the winner is not.
    const { secret, root, kept } = dtPair('sd_M');
    const s = anyShoe({ gameId: 'dragon-tiger', table: 1, shoeNo: 1, secret, seedId: 'sd_M', root, cut: { at: 200, by: 'player' }, rounds: [['R-1', 2]], status: 'shuffled', shoe: 'sh_M' });
    const dr = s.record.reveal.rounds[0]!;
    const good = dtDetail(s.dealing[dr.from]!, s.dealing[dr.from + 1]!);
    const flipped = good.winner === 'tiger' ? 'dragon' : 'tiger';
    const p = proofOf('dragon-tiger', [], () => undefined, { seedId: 'sd_M', shoes: [{ shoe: 'sh_M', table: 1, from: dr.from, to: dr.to }], outcome: { detail: { ...good, winner: flipped } } });
    expect(verifyRound(p, SEED, { pair: kept, shoes: [s.record] }).errors.join()).toMatch(new RegExp(`outcome: the winner is ${good.winner}, the proof says "${flipped}"`));
    expect(verifyRound({ ...p, outcome: { detail: { ...good, suited: !good.suited } } }, SEED, { pair: kept, shoes: [s.record] }).errors.join()).toMatch(/outcome: suited is/);
  });

  it('N: the draw plan cannot be switched off: no detail, a detail that is not an object, a void round or steps outside a round with filler draws', () => {
    const kept = keptPair('roulette');
    let pad = 1;
    const padded = (j: number) => {
      const r = roundRng(SEED, 'roulette', CS, 0);
      for (let i = 0; i < j; i++) r.int(2);
      const v = r.int(37);
      return { v, step: { nonce: 0, kind: 'act', status: 'ok' as const, draws: r.draws.slice(), words: r.words } };
    };
    while (padded(pad).v !== 0) pad++;
    const base = { ...proofOf('roulette', [], () => undefined), steps: [padded(pad).step] };
    for (const outcome of [{ result: { kind: 'number', n: 0 } }, { result: {}, detail: 'pocket 0' }, { result: {}, detail: null }, null]) {
      const check = verifyRound({ ...base, outcome }, SEED, { pair: kept });
      expect(check, JSON.stringify(outcome)).toMatchObject({ ok: false, provable: false });
    }
    expect(verifyRound({ ...base, outcome: { result: {} } }, SEED, { pair: kept }).errors).toEqual(['outcome: the proof states no outcome detail: the round of a mapped game must state its outcome']);
    expect(verifyRound({ ...base, outcome: { void: true } }, SEED, { pair: kept }).errors.join()).toMatch(/outcome: the spin draws int\(37\), the step drew int\(2\)/);
    expect(verifyRound({ ...base, roundId: null, outcome: null }, SEED, { pair: kept }).errors).toEqual(['outcome: nonce 0 drew outside a round: roulette draws only its spin']);
    // A void round that drew its plan (a flight that took off, then the stake went back) or nothing passes.
    const hf = keptPair('high-flyer');
    const flight = proofOf('high-flyer', [0], (r) => r.int(2 ** 32), { outcome: { void: true } });
    expect(verifyRound(flight, SEED, { pair: hf })).toMatchObject({ ok: true, provable: true, outcome: { checked: false } });
    expect(verifyRound({ ...flight, steps: [] }, SEED, { pair: hf }).ok).toBe(true);
    // High Flyer without its detail: the filler before the flight would pass otherwise.
    const r = roundRng(SEED, 'high-flyer', CS, 0);
    r.int(2);
    r.int(2 ** 32);
    const low = { ...proofOf('high-flyer', [], () => undefined), steps: [{ nonce: 0, kind: 'act', status: 'ok' as const, draws: r.draws.slice(), words: r.words }], outcome: { result: { kind: 'multiplier' } } };
    expect(verifyRound(low, SEED, { pair: hf })).toMatchObject({ ok: false, provable: false });
  });

  it('O: the cut the player asked for goes into verifyRound and verifyPair through its own records', () => {
    const { secret, root, kept } = dtPair('sd_O');
    // The player cut at 200; the record says the player cut at 202.
    const s = anyShoe({ gameId: 'dragon-tiger', table: 1, shoeNo: 1, secret, seedId: 'sd_O', root, cut: { at: 202, by: 'player' }, rounds: [['R-1', 2]], status: 'shuffled', shoe: 'sh_O' });
    const p = dtProof('p_O', 'sd_O', 'R-1', 'sh_O', s.record.reveal.rounds[0]!, s.dealing);
    const own = { proofs: ['p_O'], shoes: ['sh_O'], nonce: 0, cuts: { sh_O: { at: 200 } }, hands: { sh_O: s.record.reveal.rounds } };
    expect(verifyRound(p, SEED, { pair: kept, shoes: [s.record] })).toMatchObject({ ok: true, provable: false });
    expect(verifyRound(p, SEED, { pair: kept, shoes: [s.record], own }).errors.join()).toMatch(/the player cut at 200, the record says player at 202/);
    expect(verifyPair(revealOf(kept, SEED, -1, [{ table: 1, shoeNo: 1 }]), [p], [s.record], { pair: kept, own }).errors.join()).toMatch(/shoe sh_O: the player cut at 200, the record says player at 202/);
  });

  it('Q: the reveal received at the rotation binds the old chain: a later reveal with more shoes fails', () => {
    const { secret, root, kept } = dtPair('sd_Q');
    const shoes = [1, 2, 3].map((no) => anyShoe({ gameId: 'dragon-tiger', table: 1, shoeNo: no, secret, seedId: 'sd_Q', root, rounds: [], status: 'shuffled', shoe: `sh_Q${no}` }).record);
    const atRotation = { ...kept, revealedAt: 9000, lastShoes: [{ table: 1, shoeNo: 1 }] };
    const later = revealOf(kept, SEED, -1, [{ table: 1, shoeNo: 3 }]);
    expect(verifyPair(later, [], shoes, { pair: kept }).ok).toBe(true);
    expect(verifyPair(later, [], shoes, { pair: atRotation }).errors).toContain('pair: the last shoe numbers are not those of the reveal received at the rotation');
    expect(verifyPair(revealOf(kept, SEED, -1, [{ table: 1, shoeNo: 1 }]), [], shoes.slice(0, 1), { pair: atRotation }).ok).toBe(true);
  });

  it('S: a client seed sent for an earlier pair too fails; the one sending a rotation carried over does not', () => {
    const a = keptPair('roulette', 'sd_S1', { clientSeed: 'lucky7', clientSeedAt: 20 });
    const b = keptPair('roulette', 'sd_S2', { clientSeed: 'lucky7', committedAt: 5000, clientSeedAt: 5100 });
    const r = roundRng(SEED, 'roulette', 'lucky7', 0);
    const pocket = r.int(37);
    const p = { ...proofOf('roulette', [], () => undefined), seedId: 'sd_S2', clientSeed: 'lucky7', steps: [{ nonce: 0, kind: 'act', status: 'ok' as const, draws: r.draws.slice(), words: r.words }], outcome: rouletteOutcome(pocket) };
    expect(verifyRound(p, SEED, { pair: b })).toMatchObject({ ok: true, provable: true });
    expect(verifyRound(p, SEED, { pair: b, pairs: [a] }).errors).toEqual(['the client seed was sent for pair sd_S1 too: a client seed used again proves nothing']);
    expect(verifyPair(revealOf(b, SEED, 0), [p], [], { pair: b, pairs: [a] }).errors.join()).toMatch(/pair: the client seed was sent for pair sd_S1 too/);
    // Carried over by a rotation: the next pair was committed before the one sending, both keep its time.
    const carried = keptPair('roulette', 'sd_S2', { clientSeed: 'lucky7', committedAt: 15, clientSeedAt: 20 });
    expect(verifyRound(p, SEED, { pair: carried, pairs: [a] })).toMatchObject({ ok: true, provable: true });
  });
});

describe('encoding', () => {
  it('a table is a number: "1" is not a table, so no two inputs give one message', () => {
    expect(isTableRef(1)).toBe(true);
    expect(isTableRef('1')).toBe(false);
    expect(isTableRef(0)).toBe(false);
    expect(() => shoeOrder(chainLink(SECRET, 3, 1), { gameId: 'baccarat', table: '1' as unknown as number, clientSeed: CS, shoeNo: 1 }, 8)).toThrow(/bad table/);
    expect(message.shoe('g', 1, CS, 1, 0)).toBe(`fairshoe/v1/shoe:g:1:${CS}:1:0`);
  });

  it('root lines sort by their bytes: table 10 before table 1', () => {
    expect(shoeRoot(['baccarat:1:x', 'baccarat:10:x', 'baccarat:2:x']).lines).toEqual(['baccarat:10:x', 'baccarat:1:x', 'baccarat:2:x']);
  });
});

describe('distribution', () => {
  /** Pearson chi-square of observed counts against equal expectation. */
  const chi2 = (counts: number[]): number => {
    const total = counts.reduce((a, b) => a + b, 0);
    const e = total / counts.length;
    return counts.reduce((s, c) => s + ((c - e) * (c - e)) / e, 0);
  };

  it('int(37) over 18,500 nonces is uniform (chi-square, 36 degrees of freedom, p > 0.001)', () => {
    const counts = new Array<number>(37).fill(0);
    for (let n = 0; n < 37 * 500; n++) counts[roundRng(SEED, 'roulette', CS, n).int(37)]! += 1;
    expect(chi2(counts)).toBeLessThan(67.99);
  });

  it('shuffling 4 cards gives all 24 orders equally often (chi-square, 23 df, p > 0.001)', () => {
    const counts = new Map<string, number>();
    for (let i = 1; i <= 24 * 200; i++) {
      const rng = tapeRng(new HmacStream(fromHex(SEED), (b) => `fairshoe/v1/shoe:perm:1:${CS}:${i}:${b}`));
      const key = shuffleInPlace(['a', 'b', 'c', 'd'], rng).join('');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(24);
    expect(chi2([...counts.values()])).toBeLessThan(49.73);
  });

  it('a rotation by k in {1, 2, 3} maps the 24 orders of 4 cards onto each order exactly 3 times', () => {
    const perms: string[][] = [];
    const permute = (rest: string[], acc: string[]): void => {
      if (rest.length === 0) perms.push(acc);
      rest.forEach((x, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, x]));
    };
    permute(['a', 'b', 'c', 'd'], []);
    const counts = new Map<string, number>();
    for (const p of perms) for (const k of [1, 2, 3]) counts.set(rotate(p, k).join(''), (counts.get(rotate(p, k).join('')) ?? 0) + 1);
    expect(counts.size).toBe(24);
    expect([...counts.values()].every((c) => c === 3)).toBe(true);
  });

  it('rejection sampling never returns a value of the incomplete top bucket', () => {
    // A word source that serves the largest words first: they must all be rejected for n = 3 (2^32 mod 3 = 1).
    const words = [0xffff_ffff, 0xffff_fffe, 7];
    let i = 0;
    const src = { next32: () => words[i++]!, get words() { return i; } };
    expect(uniformInt(src, 3)).toBe(0xffff_fffe % 3);
    expect(i).toBe(2);
  });
});
