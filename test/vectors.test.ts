/** Test vectors (vectors/v1.json, written by vectors/generate-node.mjs, an independent node:crypto implementation). */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from './harness.ts';
import {
  autoCut,
  burnOf,
  chainLink,
  chainTerminal,
  checkOutcome,
  crashPoint,
  LIB,
  linkReaches,
  shoeRulesFor,
  verifyPair,
  verifyRound,
  verifySeedReveal,
  verifyShoe,
  type RoundProof,
  fromHex,
  hmacSha256,
  lettersOf,
  roundRng,
  rotate,
  serverSeedHash,
  shoeHash,
  shoeOrder,
  shoeRoot,
  shoeSalt,
  toHex,
  utf8,
} from '../src/index.ts';

const V1 = JSON.parse(readFileSync(new URL('../vectors/v1.json', import.meta.url), 'utf8'));
const SEED: string = V1.serverSeed;
const CS: string = V1.clientSeed;
const SECRET = fromHex(V1.chainSecret);

describe('fairshoe/v1 vectors', () => {
  it('server seed hash and the first block of the round stream', () => {
    expect(serverSeedHash(SEED)).toBe(V1.serverSeedHash);
    const b = V1.streamBlock0;
    expect(toHex(hmacSha256(fromHex(SEED), utf8(`fairshoe/v1/stream:${b.gameId}:${CS}:${b.nonce}:${b.block}`)))).toBe(b.hmac);
  });

  it('roulette, craps and high flyer draws', () => {
    expect(V1.roulette.nonces.map((n: number) => roundRng(SEED, 'roulette', CS, n).int(37))).toEqual(V1.roulette.values);
    expect(
      V1.craps.nonces.map((n: number) => {
        const r = roundRng(SEED, 'craps', CS, n);
        return [r.int(6) + 1, r.int(6) + 1];
      }),
    ).toEqual(V1.craps.dice);
    expect(V1.highFlyer.nonces.map((n: number) => roundRng(SEED, 'high-flyer', CS, n).int(2 ** 32))).toEqual(V1.highFlyer.values);
    expect(V1.highFlyer.values.map(crashPoint)).toEqual(V1.highFlyer.crash);
  });

  it('american roulette (37 is "00") and dice baccarat draws', () => {
    const a = V1.americanRoulette;
    expect(a.nonces.map((n: number) => roundRng(SEED, a.gameId, CS, n).int(38))).toEqual(a.values);
    expect(a.pockets).toContain('00');
    a.nonces.forEach((n: number, i: number) => {
      const r = roundRng(SEED, a.gameId, CS, n);
      r.int(38);
      const proof = { roundId: 'R', gameId: a.gameId, steps: [{ nonce: n, kind: 'act', status: 'ok', draws: r.draws, words: r.words }], outcome: { detail: { pocket: a.pockets[i] } } };
      expect(checkOutcome(proof as never, null)).toMatchObject({ checked: true, errors: [] });
    });
    const d = V1.diceBaccarat;
    expect(
      d.nonces.map((n: number) => {
        const r = roundRng(SEED, d.gameId, CS, n);
        const x = [0, 1, 2, 3].map(() => r.int(6) + 1);
        return { player: x.slice(0, 2), banker: x.slice(2) };
      }),
    ).toEqual(d.dice);
  });

  it('int(n) at the edges: n = 1 reads nothing, 2, 3, 2^31 + 1, 2^32, and a forced rejection', () => {
    for (const e of V1.intEdges) {
      const r = roundRng(SEED, e.gameId, CS, e.nonce);
      expect(r.int(e.n)).toBe(e.v);
      expect(r.words).toBe(e.words);
    }
    const x = V1.rejection;
    const r = roundRng(SEED, x.gameId, CS, x.nonce);
    expect(r.int(x.n)).toBe(x.v);
    expect(r.words).toBe(x.words);
    expect(r.draws).toEqual([{ n: x.n, v: x.v }]);
    expect(() => r.int(0)).toThrow(RangeError);
    expect(() => r.int(2 ** 32 + 1)).toThrow(RangeError);
    expect(() => r.int(1.5)).toThrow(RangeError);
  });

  it('chain links, terminal and root', () => {
    const c = V1.chain;
    for (let i = 0; i <= c.length; i++) expect(toHex(chainLink(SECRET, c.length, i))).toBe(c.links[i]);
    expect(toHex(chainTerminal(SECRET, 2000))).toBe(c.terminal2000);
    expect(toHex(chainLink(SECRET, 2000, 1999))).toBe(c.link1999of2000);
    expect(shoeRoot([...V1.root.lines].reverse())).toEqual({ hash: V1.root.hash, lines: V1.root.lines });
    expect(V1.root.lines[0]).toMatch(/^baccarat:10:/);
  });

  it('baccarat shoe: order, salt, hash, automatic cut, dealing order and burn', () => {
    const v = V1.baccarat;
    const link = chainLink(SECRET, V1.chain.length, v.shoeNo);
    expect(toHex(link)).toBe(v.link);
    const inputs = { gameId: v.gameId, table: v.table, clientSeed: CS, shoeNo: v.shoeNo };
    const o = shoeOrder(link, inputs, v.decks);
    expect(o.order.slice(0, 10)).toEqual(v.first10);
    expect(o.words).toBe(v.words);
    expect(lettersOf(o.order)).toBe(v.order);
    const salt = shoeSalt(link, inputs);
    expect(toHex(salt)).toBe(v.salt);
    expect(shoeHash(salt, o.order)).toBe(v.shoeHash);
    expect(shoeHash(v.salt, o.order)).toBe(v.shoeHash);
    // The salt goes in as 32 raw bytes: its hex text gives another hash.
    expect(v.shoeHashHexSalt).not.toBe(v.shoeHash);
    const k = autoCut(inputs);
    expect(k).toBe(v.autoCut);
    const d = rotate(o.order, k);
    expect(d.slice(0, 10)).toEqual(v.dealtFirst10);
    expect(burnOf('bac-value', d)).toEqual(v.burn);
    expect(v.cut).toBe(k);
    expect(v.endAt).toBe(shoeRulesFor('baccarat')!.endAt);
    expect([d[363], d[364]]).toEqual([v.atEndAtMinus1, v.atEndAt364]);
  });

  it('cut range edges, and the burns of a ten and an ace', () => {
    const rules = shoeRulesFor('baccarat')!;
    expect(rules.cutRange).toEqual([V1.cutEdges.min, V1.cutEdges.max]);
    for (const k of V1.cutEdges.allowed) expect(k >= rules.cutRange[0] && k <= rules.cutRange[1]).toBe(true);
    for (const k of V1.cutEdges.refused) expect(k >= rules.cutRange[0] && k <= rules.cutRange[1]).toBe(false);
    for (const b of [V1.burns.ten, V1.burns.ace]) {
      const inputs = { gameId: b.gameId, table: b.table, clientSeed: CS, shoeNo: b.shoeNo };
      expect(autoCut(inputs)).toBe(b.cut);
      const d = rotate(shoeOrder(fromHex(b.key), inputs, 8).order, b.cut);
      expect(d[0]).toBe(b.first);
      expect(burnOf('bac-value', d)).toEqual(b.burn);
    }
    expect([V1.burns.ten.burn.cards, V1.burns.ace.burn.cards]).toEqual([11, 2]);
  });

  it('two chains whose shoes end in reverse order: no revealed link leads into the other chain', () => {
    const t = V1.twoChains;
    const [a, b] = t.tables;
    for (const x of [a, b]) for (let i = 0; i <= t.length; i++) expect(toHex(chainLink(fromHex(x.secret), t.length, i))).toBe(x.links[i]);
    for (const r of t.reveals) {
      const own = r.table === 1 ? a : b;
      const other = r.table === 1 ? b : a;
      const revealed = fromHex(own.links[r.shoeNo]);
      for (let steps = 0; steps <= t.length; steps++) for (const target of other.links) expect(linkReaches(revealed, steps, target)).toBe(false);
    }
  });

  it('complete records verify against the pair kept before the client seed: a Dragon Tiger shoe, a solo blackjack round, a roulette round with a discarded step', () => {
    expect(V1.lib).toBe(LIB);
    const dt = V1.records.dragonTiger;
    expect(verifySeedReveal(dt.pair)).toEqual({ ok: true, errors: [] });
    // The player's own records of the shoe: the cut it asked for (200) and the hands it saw (the free hand too).
    const cuts = { [dt.commit.shoe]: { at: 200 } };
    const hands = { [dt.commit.shoe]: dt.reveal.rounds };
    expect(verifyShoe(dt.commit, dt.reveal, { pair: dt.kept, expectedCut: { at: 200 }, hands: dt.reveal.rounds })).toMatchObject({ ok: true, errors: [], provable: true });
    for (const p of dt.proofs) {
      const r = verifyRound(p, p.serverSeed, { shoes: [{ commit: dt.commit, reveal: dt.reveal }], pairs: [dt.kept], own: { cuts, hands } });
      expect(r.errors).toEqual([]);
      expect(r).toMatchObject({ provable: true, outcome: { checked: true } });
    }
    const dtOwn = { proofs: dt.proofs.map((p: RoundProof) => p.id), shoes: [dt.commit.shoe], nonce: 0, cuts, hands };
    expect(verifyPair(dt.pair, dt.proofs, [{ commit: dt.commit, reveal: dt.reveal }], { pair: dt.kept, own: dtOwn })).toMatchObject({ ok: true, provable: true, counts: { proofs: 2, shoes: 1, shuffled: 1, free: 1 } });
    const bj = V1.records.soloBlackjack;
    expect(verifyShoe(bj.commit, bj.reveal, { pair: bj.kept, expectedCut: 'auto' }).errors).toEqual([]);
    expect(verifyPair(bj.pair, bj.proofs, [{ commit: bj.commit, reveal: bj.reveal }], { pair: bj.kept }).errors).toEqual([]);
    expect(verifyRound(bj.proofs[0], bj.proofs[0].serverSeed, { shoes: [{ commit: bj.commit, reveal: bj.reveal }], pairs: [bj.kept] })).toMatchObject({ ok: true, provable: true, outcome: { checked: false } });
    const ro = V1.records.roulette;
    expect(verifyPair(ro.pair, ro.proofs, [], { pair: ro.kept })).toMatchObject({ ok: true, counts: { steps: 2, discarded: 1 } });
    expect(verifyRound(ro.proofs[0], undefined, { pair: ro.kept })).toMatchObject({ ok: true, provable: true, outcome: { checked: true } });
    // Leave out a proof, a shoe, or change the cut: the record shows it.
    expect(verifyPair(ro.pair, [], [], { pair: ro.kept }).errors.join()).toMatch(/nonces 0 to 1 are in no proof/);
    expect(verifyPair(dt.pair, dt.proofs, [], { pair: dt.kept }).errors.join()).toMatch(/shoes 1 to 1 expected/);
    expect(verifyShoe(dt.commit, { ...dt.reveal, cut: { at: 201, by: 'player' } }, { pair: dt.kept }).ok).toBe(false);
  });

  it('negative vectors: draws that are all on the round stream, before or after the spin or the flight, are refused', () => {
    const n = V1.negative;
    expect(n.roulette.padded.steps[0].draws).toHaveLength(n.roulette.padding + 1);
    expect(n.roulette.honestPocket).not.toBe(0);
    for (const p of [n.roulette.padded, n.roulette.twice]) {
      const r = verifyRound(p, p.serverSeed, { pair: n.roulette.kept });
      expect(r.ok).toBe(false);
      expect(r.errors.join()).toMatch(/outcome: the spin draws int\(37\), the step drew/);
      // Every draw itself is right: only the plan of the game gives the forgery away.
      expect(r.errors.every((e: string) => e.startsWith('outcome:'))).toBe(true);
    }
    const h = verifyRound(n.highFlyer.padded, n.highFlyer.padded.serverSeed, { pair: n.highFlyer.kept });
    expect(h.errors).toEqual([expect.stringMatching(/outcome: the flight draws int\(2\^32\), the step drew int\(2\), int\(2\^32\)/)]);
    expect(n.highFlyer.padded.outcome.detail.crash).toBeLessThan(n.highFlyer.honestCrash);
  });

  it("own records: a baccarat shoe with a free hand and two bets at table 3 is provable only with the player's cut, hands and tables", () => {
    const b = V1.ownRecords.baccarat;
    const shoes = [{ commit: b.commit, reveal: b.reveal }];
    expect(verifyShoe(b.commit, b.reveal, { pair: b.kept, expectedCut: b.own.cuts[b.commit.shoe], hands: b.own.hands[b.commit.shoe] })).toMatchObject({ ok: true, errors: [], provable: true });
    for (const p of b.proofs) {
      const r = verifyRound(p, p.serverSeed, { pair: b.kept, shoes, own: b.own });
      expect(r.errors).toEqual([]);
      expect(r).toMatchObject({ ok: true, provable: true, outcome: { checked: true } });
      // The tableau of the independent implementation is the library's.
      expect(r.outcome.summary).toContain(p.outcome.detail.winner);
      // Without the player's records the arithmetic checks out, but cut, hands and table are the server's word.
      expect(verifyRound(p, p.serverSeed, { pair: b.kept, shoes })).toMatchObject({ ok: true, provable: false });
    }
    expect(verifyPair(b.pair, b.proofs, shoes, { pair: b.kept, own: b.own })).toMatchObject({ ok: true, provable: true, counts: { proofs: 2, shoes: 1, shuffled: 1, free: 1 } });
    expect(b.pairRecords).toEqual({ seedId: b.pair.seedId, gameId: 'baccarat', proofs: b.proofs.map((p: RoundProof) => p.id), shoes: [b.commit.shoe] });
  });

  it('negative own records: a slipped free hand, a moved cut, a hand off the tableau, a flipped winner, another table, a solo shoe with more than its round, a missing detail, a reused client seed', () => {
    const n = V1.negativeOwn;
    const f = n.dragonTigerFreeHand;
    const fShoes = [{ commit: f.commit, reveal: f.reveal }];
    expect(verifyShoe(f.commit, f.reveal, { pair: f.kept, expectedCut: { at: 200 } })).toMatchObject({ ok: true, provable: false });
    expect(verifyShoe(f.commit, f.reveal, { pair: f.kept, expectedCut: { at: 200 }, hands: f.own.hands[f.commit.shoe] }).errors.join()).toMatch(/the shoe lists round R-1 .*, free hand .*, round R-2 .*; the player saw round R-1 .*, round R-2/);
    expect(verifyPair(f.pair, f.proofs, fShoes, { pair: f.kept, own: f.own }).ok).toBe(false);
    const c = n.dragonTigerCutMoved;
    expect(verifyShoe(c.commit, c.reveal, { pair: c.kept, expectedCut: { at: c.askedCut } }).errors).toEqual([`the player cut at ${c.askedCut}, the record says player at ${c.recordedCut}`]);
    const t = n.baccaratFreeHandTooLong;
    expect(verifyShoe(t.commit, t.reveal, { pair: t.kept }).errors.join()).toMatch(new RegExp(`the free hand at cards \\d+ to \\d+ takes ${t.dealt} cards, a hand of baccarat takes ${t.tableauCards} there`));
    const w = n.baccaratWinner;
    expect(verifyRound(w.proof, w.proof.serverSeed, { pair: w.kept, shoes: [{ commit: w.commit, reveal: w.reveal }], own: w.own }).errors).toEqual([`outcome: the winner is ${w.honest}, the proof says "${w.stated}"`]);
    const o = n.baccaratOtherTable;
    expect(verifyRound(o.proof, o.proof.serverSeed, { pair: o.kept, shoes: [{ commit: o.commit, reveal: o.reveal }], own: o.own }).errors).toEqual([`the round was dealt at table 3, the player bet at table ${o.betAt}`]);
    expect(verifyShoe(n.soloSkipped.commit, n.soloSkipped.reveal, { pair: n.soloSkipped.kept }).errors).toEqual(['a shoe for one round lists 2 rounds', 'a shoe for one round lists a hand outside a round']);
    expect(verifyShoe(n.soloTwoRounds.commit, n.soloTwoRounds.reveal, { pair: n.soloTwoRounds.kept }).errors).toEqual(['a shoe for one round lists 2 rounds']);
    const d = n.rouletteNoDetail;
    expect(verifyRound(d.proof, d.proof.serverSeed, { pair: d.kept }).errors).toEqual(['outcome: the proof states no outcome detail: the round of a mapped game must state its outcome']);
    const s = n.seedReused;
    expect(verifyRound(s.proof, s.proof.serverSeed, { pair: s.kept })).toMatchObject({ ok: true, provable: true });
    expect(verifyRound(s.proof, s.proof.serverSeed, { pair: s.kept, pairs: [s.first] }).errors).toEqual([`the client seed was sent for pair ${s.first.seedId} too: a client seed used again proves nothing`]);
    expect(verifyPair(s.pair, [s.proof], [], { pair: s.kept, pairs: [s.first] }).ok).toBe(false);
  });

  it('blackjack shoe: order, salt, hash, automatic cut, cards at 207 and 208', () => {
    const v = V1.blackjack;
    const link = chainLink(SECRET, V1.chain.length, v.shoeNo);
    expect(toHex(link)).toBe(v.link);
    const inputs = { gameId: v.gameId, table: v.table, clientSeed: CS, shoeNo: v.shoeNo };
    const o = shoeOrder(link, inputs, v.decks);
    expect(o.order.slice(0, 10)).toEqual(v.first10);
    expect(o.words).toBe(v.words);
    expect(toHex(shoeSalt(link, inputs))).toBe(v.salt);
    expect(shoeHash(v.salt, o.order)).toBe(v.shoeHash);
    expect(autoCut(inputs)).toBe(v.autoCut);
    const d = rotate(o.order, v.autoCut);
    expect(d.slice(0, 10)).toEqual(v.dealtFirst10);
    expect(v.cut).toBe(v.autoCut);
    expect(v.endAt).toBeNull();
    expect([d[207], d[208]]).toEqual([v.at207, v.at208]);
  });

  it('a shuffle with a rejected word reads 416 words for 415 swaps', () => {
    const v = V1.shuffleRejection;
    const o = shoeOrder(fromHex(v.key), { gameId: v.gameId, table: v.table, clientSeed: CS, shoeNo: v.shoeNo }, 8);
    expect(o.words).toBe(v.words);
    expect(o.draws).toHaveLength(415);
    expect(o.order.slice(0, 10)).toEqual(v.first10);
  });

  it('the automatic cut stays within 52 to 364 and reaches both ends', () => {
    const v = V1.autoCutSpan;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = v.shoeNos[0]; i <= v.shoeNos[1]; i++) {
      const k = autoCut({ gameId: v.gameId, table: v.table, clientSeed: CS, shoeNo: i });
      lo = Math.min(lo, k);
      hi = Math.max(hi, k);
    }
    expect([lo, hi]).toEqual([v.min, v.max]);
  });
});

describe('library = independent node:crypto implementation', () => {
  /** The round stream written directly against node:crypto. */
  function nodeInts(seed: Buffer, gameId: string, cs: string, nonce: number, ns: number[]): { values: number[]; words: number } {
    let b = 0;
    let buf = Buffer.alloc(0);
    let pos = 0;
    let words = 0;
    const next = (): number => {
      if (pos >= buf.length) {
        buf = createHmac('sha256', seed).update(`fairshoe/v1/stream:${gameId}:${cs}:${nonce}:${b++}`).digest();
        pos = 0;
      }
      words++;
      const w = buf.readUInt32BE(pos);
      pos += 4;
      return w;
    };
    const values = ns.map((n) => {
      if (n === 1) return 0;
      const limit = 2 ** 32 - (2 ** 32 % n);
      for (;;) {
        const w = next();
        if (w < limit) return w % n;
      }
    });
    return { values, words };
  }

  it('gives the same draws for random seeds, nonces and ranges', () => {
    for (let t = 0; t < 40; t++) {
      const seed = randomBytes(32);
      const nonce = t * 7919;
      const ns = Array.from({ length: 30 }, (_, i) => [1, 2, 6, 37, 38, 52, 416, 2 ** 31 + 1, 2 ** 32, 1000 + t * i][i % 10]!);
      const r = roundRng(seed.toString('hex'), 'g-1', `cs_${t}`, nonce);
      const got = ns.map((n) => r.int(n));
      const want = nodeInts(seed, 'g-1', `cs_${t}`, nonce, ns);
      expect(got).toEqual(want.values);
      expect(r.words).toBe(want.words);
    }
  });

  it('the server seed hash is SHA-256 of the 32 bytes', () => {
    const seed = randomBytes(32);
    expect(serverSeedHash(seed.toString('hex'))).toBe(createHash('sha256').update(seed).digest('hex'));
  });
});
