/** fairshoe-verify (bin/) on the examples and the test vectors: bundles, single records, own records, input errors. */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, EXIT, formatReport, InputError, verifyBundle, type Bundle, type Report } from '../bin/report.ts';
import type { ShoeRecord } from '../src/index.ts';
import { describe, expect, it } from './harness.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(ROOT, 'bin', 'fairshoe-verify');
const V1 = JSON.parse(readFileSync(join(ROOT, 'vectors', 'v1.json'), 'utf8'));
const read = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

function run(args: string[], input?: string): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8', ...(input !== undefined ? { input } : {}) });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Writes each value to its own file in a fresh folder; returns the paths and a cleanup. */
function files(values: Record<string, unknown>): { paths: string[]; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'fairshoe-'));
  const paths = Object.entries(values).map(([name, v]) => {
    const p = join(dir, name);
    writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));
    return p;
  });
  return { paths, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const check = (bundle: Bundle): Report => verifyBundle(collect([{ name: 'test', value: bundle }]));

const dt = V1.records.dragonTiger;
const dtShoe = dt.commit.shoe as string;
const dtOwn = { proofs: dt.proofs.map((p: { id: string }) => p.id), shoes: [dtShoe], nonce: 0, cuts: { [dtShoe]: { at: 200 } }, hands: { [dtShoe]: dt.reveal.rounds } };
const dtBundle: Bundle = { kept: dt.kept, own: dtOwn, seed: dt.pair, proofs: dt.proofs, shoes: [{ commit: dt.commit, reveal: dt.reveal }], records: dt.pairRecords };

const EXAMPLES: Record<string, number> = {
  'baccarat.json': EXIT.provable,
  'baccarat-flipped-winner.json': EXIT.failed,
  'dragon-tiger.json': EXIT.provable,
  'dragon-tiger-without-own-records.json': EXIT.ok,
  'roulette.json': EXIT.provable,
  'solo-blackjack.json': EXIT.provable,
};

describe('fairshoe-verify', () => {
  it('reports every example as its note says, with its exit status', () => {
    expect(readdirSync(join(ROOT, 'examples')).sort()).toEqual(Object.keys(EXAMPLES).sort());
    for (const [name, code] of Object.entries(EXAMPLES)) {
      const r = run([join('examples', name)]);
      expect(r.code, `${name}: ${r.out}${r.err}`).toBe(code);
      expect(r.out).toMatch(/^fairshoe\/v1 \(fairshoe@1\.1\.0\)\n/);
      expect(r.out).toMatch(code === EXIT.provable ? /\nresult: provable\n$/ : code === EXIT.failed ? /\nresult: FAILED/ : /\nresult: ok, not provable\n$/);
    }
    expect(run(['examples/baccarat-flipped-winner.json']).out).toMatch(/FAILED +proof pf_vectorbaccara1 .*\n +error: outcome: the winner is player, the proof says "banker"/);
    expect(run(['examples/dragon-tiger-without-own-records.json']).out).toContain('not provable: the cut the player asked for on this shoe is not given');
  });

  it('the examples hold the records of the test vectors', () => {
    const ex = read('examples/dragon-tiger.json') as Bundle;
    expect(ex).toMatchObject({ kept: dt.kept, own: dtOwn, seed: dt.pair, proofs: dt.proofs, shoes: [{ commit: dt.commit, reveal: dt.reveal }], records: dt.pairRecords });
    const b = V1.ownRecords.baccarat;
    expect(read('examples/baccarat.json')).toMatchObject({ kept: b.kept, own: b.own, seed: b.pair, proofs: b.proofs, shoes: [{ commit: b.commit, reveal: b.reveal }], records: b.pairRecords });
    const w = V1.negativeOwn.baccaratWinner;
    expect(read('examples/baccarat-flipped-winner.json')).toMatchObject({ kept: w.kept, own: w.own, proofs: [w.proof], shoes: [{ commit: w.commit, reveal: w.reveal }] });
    expect(read('examples/roulette.json')).toMatchObject({ kept: V1.records.roulette.kept, seed: V1.records.roulette.pair, proofs: V1.records.roulette.proofs });
    expect(read('examples/solo-blackjack.json')).toMatchObject({ kept: V1.records.soloBlackjack.kept, seed: V1.records.soloBlackjack.pair, proofs: V1.records.soloBlackjack.proofs });
  });

  it('takes the records as a server gives them, one per file or in an array, and from standard input', () => {
    const f = files({
      'mine.json': { kept: dt.kept, own: dtOwn },
      'seed.json': dt.pair,
      'proofs.json': dt.proofs,
      'shoe.json': { commit: dt.commit, reveal: dt.reveal },
      'records.json': dt.pairRecords,
      'kept.json': { kept: dt.kept },
    });
    const [mine, seed, proofs, shoe, records, kept] = f.paths as [string, string, string, string, string, string];
    try {
      const r = run([mine, seed, proofs, shoe, records]);
      expect(r.code, r.out + r.err).toBe(EXIT.provable);
      // The same record twice is one record.
      expect(run([mine, seed, proofs, shoe, records, proofs]).code).toBe(EXIT.provable);
      expect(run(['-', seed, proofs, shoe, records], JSON.stringify({ kept: dt.kept, own: dtOwn })).code).toBe(EXIT.provable);
      // Without the player's own records: ok, not provable.
      const without = run([kept, seed, proofs, shoe, records]);
      expect(without.code).toBe(EXIT.ok);
      expect(without.out).toContain('not provable: the hands the player saw dealt from this shoe are not given');
      // Without the shoe, a card round has no cards on record.
      expect(run([mine, seed, proofs, records]).out).toMatch(/FAILED +proof pf_vectordragon01/);
    } finally {
      f.done();
    }
  });

  it('--json prints the report', () => {
    const r = run(['--json', 'examples/dragon-tiger.json']);
    expect(r.code).toBe(EXIT.provable);
    const report = JSON.parse(r.out) as Report;
    expect(report).toMatchObject({ alg: 'fairshoe/v1', lib: 'fairshoe@1.1.0', status: 'provable', ok: true, provable: true });
    expect(report.checks.map((c) => `${c.kind} ${c.status}`)).toEqual(['shoe provable', 'proof provable', 'proof provable', 'reveal ok', 'pair provable', 'records provable']);
  });

  it('input it cannot read is exit status 3, nothing verified', () => {
    const f = files({ 'bad.json': '{ "kept": ', 'odd.json': { hello: 1 }, 'kept-only.json': { kept: dt.kept } });
    try {
      expect(run([f.paths[0]!])).toMatchObject({ code: EXIT.input, out: '' });
      expect(run([f.paths[0]!]).err).toMatch(/bad\.json: not JSON/);
      expect(run([f.paths[1]!]).err).toMatch(/odd\.json: neither a bundle .*not hello/);
      expect(run([f.paths[2]!]).err).toMatch(/nothing to verify/);
      expect(run(['examples/missing.json']).err).toMatch(/missing\.json: ENOENT/);
      expect(run([]).code).toBe(EXIT.input);
      expect(run(['--frobnicate', 'examples/roulette.json']).err).toMatch(/unknown option --frobnicate/);
      expect(run(['--help'])).toMatchObject({ code: 0 });
      expect(run(['--help']).out).toMatch(/2 ok or pending \(not provable\), 3 the input could not\nbe read, 4 the verifier itself failed/);
      expect(run(['--version']).out).toBe('fairshoe/v1 (fairshoe@1.1.0)\n');
    } finally {
      f.done();
    }
  });

  it('a bundle whose proofs all wait for the reveal is pending (exit 2), never provable, whatever the record list says', () => {
    const ro = V1.records.roulette;
    const pending = ro.proofs.map((p: Record<string, unknown>) => ({ ...p, serverSeed: null }));
    const own = { proofs: ro.pairRecords.proofs, shoes: [], nonce: 2 };
    const f = files({ 'bundle.json': { kept: ro.kept, own, proofs: pending, records: ro.pairRecords } });
    try {
      const r = run(f.paths);
      expect(r.code, r.out + r.err).toBe(EXIT.pending);
      expect(r.out).toMatch(/\n {2}pending +proof pf_vectorroulett1 .*\n {2}pending +pair .*\n {2}provable +record list .*\nresult: pending \(no shoe, proof or pair checkable yet\), 2 pending\n$/);
      // The record list alone proves nothing either.
      expect(check({ kept: ro.kept, own, seed: undefined, proofs: pending, records: ro.pairRecords } as Bundle)).toMatchObject({ status: 'pending', provable: false });
    } finally {
      f.done();
    }
  });

  it('before the reveal a proof or a shoe that contradicts the kept pair fails at once (exit 1)', () => {
    const ro = V1.records.roulette;
    const proof = { ...ro.proofs[0], serverSeed: null };
    const pendingWith = (p: Record<string, unknown>): Report => check({ kept: ro.kept, proofs: [p as never] });
    expect(pendingWith(proof)).toMatchObject({ status: 'pending', ok: true });
    const lying: Array<[string, Record<string, unknown>, RegExp]> = [
      ['another server seed hash', { ...proof, serverSeedHash: '11'.repeat(32) }, /another server seed hash than the pair kept before the client seed/],
      ['another client seed', { ...proof, clientSeed: 'someone-else' }, /another client seed than the one sent/],
      ['a seed the server picked', { ...proof, clientSeedBy: 'server' }, /not provable: the server picked the client seed/],
      ['a draft algorithm', { ...proof, alg: 'draft/v0' }, /unknown algorithm draft\/v0/],
      ['another game', { ...proof, gameId: 'american-roulette' }, /the proof is of american-roulette, the pair of roulette/],
      ['nonces out of order', { ...proof, steps: [{ ...proof.steps[1] }, { ...proof.steps[0] }] }, /not increasing/],
    ];
    for (const [what, p, reason] of lying) {
      const r = pendingWith(p);
      expect(r.status, what).toBe('failed');
      expect(r.checks.find((c) => c.kind === 'proof')?.errors.join('\n'), what).toMatch(reason);
    }
    const f = files({ 'lying.json': { kept: ro.kept, proofs: [{ ...proof, serverSeedHash: '11'.repeat(32) }] } });
    try {
      expect(run(f.paths).code).toBe(EXIT.failed);
    } finally {
      f.done();
    }

    // A shoe still in play: its commitment against the kept pair of its chain and the game's rules.
    const running = (commit: Record<string, unknown>): Report => check({ kept: dt.kept, shoes: [{ commit, reveal: null } as never] });
    expect(running(dt.commit)).toMatchObject({ status: 'pending', ok: true });
    const shoes: Array<[string, Record<string, unknown>, RegExp]> = [
      ['another root', { ...dt.commit, origin: { ...dt.commit.origin, root: '22'.repeat(32) } }, /the root is not the one of the pair/],
      ['a terminal not in the root', { ...dt.commit, origin: { ...dt.commit.origin, terminal: '33'.repeat(32) } }, /the chain terminal is not in the root/],
      ['another client seed', { ...dt.commit, clientSeed: 'someone-else' }, /the client seed is not the one of the pair/],
      ['another cut card', { ...dt.commit, endAt: 300 }, /the commitment breaks the rules: cut card at 300/],
      ['another kAuto', { ...dt.commit, autoCut: dt.commit.autoCut + 1 }, /the automatic cut is not kAuto/],
      ['a draft algorithm', { ...dt.commit, alg: 'draft/v0' }, /unknown algorithm draft\/v0/],
    ];
    for (const [what, commit, reason] of shoes) {
      const r = running(commit);
      expect(r.status, what).toBe('failed');
      expect(r.checks.find((c) => c.kind === 'shoe')?.errors.join('\n'), what).toMatch(reason);
    }
  });

  it('a hostile reveal with a huge last nonce fails with one line, quickly, instead of exhausting the verifier', () => {
    const ro = V1.records.roulette;
    for (const lastNonce of [30_000_000, Number.MAX_SAFE_INTEGER]) {
      const started = Date.now();
      const r = check({ kept: ro.kept, seed: { ...ro.pair, lastNonce }, proofs: ro.proofs });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(r.status).toBe('failed');
      expect(r.checks.find((c) => c.kind === 'pair')?.errors).toContain(`nonces ${ro.proofs.flatMap((p: { steps: unknown[] }) => p.steps).length} to ${lastNonce} are in no proof`);
    }
  });

  it('a copy under node_modules (an installed package) says it runs from a checkout, exit 4, not a verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fairshoe-consumer-'));
    try {
      const copy = join(dir, 'node_modules', 'fairshoe');
      mkdirSync(copy, { recursive: true });
      for (const part of ['package.json', 'bin', 'src', 'examples']) cpSync(join(ROOT, part), join(copy, part), { recursive: true });
      const r = spawnSync(process.execPath, [join(copy, 'bin', 'fairshoe-verify'), join(copy, 'examples', 'roulette.json')], { cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(EXIT.internal);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/runs from a checkout of fairshoe .*not from an installed copy/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bundles', () => {
  it('a bundle of a pair with the player\'s records is provable; every check names what it checked', () => {
    const r = check(dtBundle);
    expect(r).toMatchObject({ status: 'provable', ok: true, provable: true });
    expect(formatReport(r)).toEqual([
      'fairshoe/v1 (fairshoe@1.1.0)',
      '  provable  shoe sh_vectordragon01 (dragon-tiger table 1, shoe 1, shuffled, cut 200 by player, 3 hands)',
      '  provable  proof pf_vectordragon01 (dragon-tiger round R-1, no nonce, outcome checked: dragon 8S, tiger 5S, dragon)',
      '  provable  proof pf_vectordragon03 (dragon-tiger round R-2, no nonce, outcome checked: dragon 4C, tiger 10S, tiger)',
      '  ok        reveal sd_vectordragon01 (dragon-tiger)',
      '  provable  pair sd_vectordragon01 (dragon-tiger): 2 proofs, 0 steps, 1 shoe, 1 free hand',
      '  provable  record list of pair sd_vectordragon01: 2 proofs, 1 shoe',
      'result: provable',
    ]);
  });

  it('a tampered record fails with the reason; the check of the pair does not repeat it', () => {
    const order = dt.reveal.order as string;
    const swapped = order[1]! + order[0]! + order.slice(2);
    const r = check({ ...dtBundle, shoes: [{ commit: dt.commit, reveal: { ...dt.reveal, order: swapped } }] });
    expect(r.status).toBe('failed');
    const shoe = r.checks.find((c) => c.kind === 'shoe')!;
    expect(shoe.errors).toContain('the order is not the shuffle of the shoe stream');
    const lines = formatReport(r);
    const at = lines.findIndex((l) => /^ {2}\S+ +pair /.test(l));
    const next = lines.findIndex((l, i) => i > at && !l.startsWith('    '));
    expect(lines.slice(at + 1, next).join('\n')).not.toMatch(/the order is not the shuffle/);
    expect(lines.at(-1)).toMatch(/^result: FAILED \(\d of 6 checks\)$/);
  });

  it('without the kept pair the reveal stands in: the records agree, nothing is provable', () => {
    const { kept: _kept, ...rest } = dtBundle;
    const r = check(rest);
    expect(r).toMatchObject({ status: 'ok', ok: true, provable: false });
    expect(r.checks[0]).toMatchObject({ kind: 'kept', unproven: [expect.stringMatching(/not given: the records are checked against the reveal/)] });
    expect(r.checks.filter((c) => c.provable === true)).toEqual([]);
    // Without a reveal either, a shoe has no pair to be checked against.
    expect(check({ shoes: [{ commit: dt.commit, reveal: dt.reveal }] }).checks[1]).toMatchObject({ kind: 'shoe', status: 'failed', errors: [expect.stringMatching(/^no pair/)] });
  });

  it('what is not revealed yet is pending: a running shoe, a proof without its server seed, the pair', () => {
    const proof = { ...dt.proofs[0], serverSeed: null };
    const r = check({ kept: dt.kept, own: dtOwn, proofs: [proof], shoes: [{ commit: dt.commit, reveal: null }] });
    expect(r.checks.map((c) => `${c.kind} ${c.status}`)).toEqual(['shoe pending', 'proof pending', 'pair pending']);
    expect(r).toMatchObject({ status: 'pending', ok: true, provable: false });
    expect(formatReport(r).at(-1)).toBe('result: pending (no shoe, proof or pair checkable yet), 3 pending');
    // A shoe that is over is checked before its pair's reveal: provable, with the rounds and the pair still pending.
    const mixed = check({ kept: dt.kept, own: dtOwn, proofs: dt.proofs.map((p: Record<string, unknown>) => ({ ...p, serverSeed: null })), shoes: [{ commit: dt.commit, reveal: dt.reveal }] });
    expect(mixed.checks.map((c) => `${c.kind} ${c.status}`)).toEqual(['shoe provable', 'proof pending', 'proof pending', 'pair pending']);
    expect(formatReport(mixed).at(-1)).toBe('result: provable, 3 pending');
  });

  it("the server's record list: a record it lists and the bundle lacks is not provable, one it leaves out fails", () => {
    const missing = check({ ...dtBundle, proofs: dt.proofs.slice(0, 1) });
    expect(missing.checks.find((c) => c.kind === 'records')).toMatchObject({ status: 'ok', unproven: ['the server lists proof pf_vectordragon03: not given here'] });
    const unlisted = check({ ...dtBundle, records: { ...dt.pairRecords, proofs: dt.pairRecords.proofs.slice(0, 1) } });
    expect(unlisted.checks.find((c) => c.kind === 'records')).toMatchObject({ status: 'failed', errors: ["proof pf_vectordragon03 of the pair is not in the server's list"] });
  });

  it('negative vectors fail through the bundle as they fail through the library', () => {
    const n = V1.negativeOwn;
    const shoe = (x: ShoeRecord): ShoeRecord[] => [{ commit: x.commit, reveal: x.reveal }];
    const cases: Array<[string, Bundle, RegExp]> = [
      ['a slipped free hand', { kept: n.dragonTigerFreeHand.kept, own: n.dragonTigerFreeHand.own, seed: n.dragonTigerFreeHand.pair, proofs: n.dragonTigerFreeHand.proofs, shoes: shoe(n.dragonTigerFreeHand) }, /the shoe lists round R-1 .*free hand/],
      ['a moved cut', { kept: n.dragonTigerCutMoved.kept, own: { cuts: { [n.dragonTigerCutMoved.commit.shoe]: { at: n.dragonTigerCutMoved.askedCut } } }, shoes: shoe(n.dragonTigerCutMoved) }, new RegExp(`the player cut at ${n.dragonTigerCutMoved.askedCut}, the record says player at ${n.dragonTigerCutMoved.recordedCut}`)],
      ['a free hand off the tableau', { kept: n.baccaratFreeHandTooLong.kept, shoes: shoe(n.baccaratFreeHandTooLong) }, /a hand of baccarat takes/],
      ['a flipped winner', { kept: n.baccaratWinner.kept, own: n.baccaratWinner.own, proofs: [n.baccaratWinner.proof], shoes: shoe(n.baccaratWinner) }, /outcome: the winner is/],
      ['another table', { kept: n.baccaratOtherTable.kept, own: n.baccaratOtherTable.own, proofs: [n.baccaratOtherTable.proof], shoes: shoe(n.baccaratOtherTable) }, new RegExp(`the player bet at table ${n.baccaratOtherTable.betAt}`)],
      ['a solo shoe with a hand outside its round', { kept: n.soloSkipped.kept, shoes: shoe(n.soloSkipped) }, /a shoe for one round lists/],
      ['a solo shoe with two rounds', { kept: n.soloTwoRounds.kept, shoes: shoe(n.soloTwoRounds) }, /a shoe for one round lists 2 rounds/],
      ['no outcome detail', { kept: n.rouletteNoDetail.kept, proofs: [n.rouletteNoDetail.proof] }, /states no outcome detail/],
      ['a reused client seed', { kept: n.seedReused.kept, pairs: [n.seedReused.first], seed: n.seedReused.pair, proofs: [n.seedReused.proof] }, /a client seed used again proves nothing/],
      ['a padded roulette spin', { kept: V1.negative.roulette.kept, proofs: [V1.negative.roulette.padded] }, /outcome: the spin draws int\(37\)/],
      ['a roulette step with two spins', { kept: V1.negative.roulette.kept, proofs: [V1.negative.roulette.twice] }, /outcome: the spin draws int\(37\)/],
      ['a padded flight', { kept: V1.negative.highFlyer.kept, proofs: [V1.negative.highFlyer.padded] }, /outcome: the flight draws/],
    ];
    for (const [what, bundle, reason] of cases) {
      const r = check(bundle);
      expect(r.status, what).toBe('failed');
      expect(r.checks.flatMap((c) => c.errors).join('\n'), what).toMatch(reason);
    }
  });

  it('collect refuses what is not one pair of fairshoe records', () => {
    const fails = (inputs: Array<{ name: string; value: unknown }>, message: RegExp): void => {
      let error: unknown = null;
      try {
        collect(inputs);
      } catch (err) {
        error = err;
      }
      expect(error instanceof InputError, String(error)).toBe(true);
      expect((error as Error).message).toMatch(message);
    };
    fails([{ name: 'a', value: 42 }], /a: neither a bundle nor a record/);
    // Nothing unknown to name: no empty list after "not".
    fails([{ name: 'a', value: {} }], /^a: neither a bundle \(keys kept, own, seed, records, pairs, proofs, shoes, later, note\) nor a record of fairshoe\/v1$/);
    fails([{ name: 'a', value: { proofs: [{}] } }], /a: an entry of "proofs" is not a round proof/);
    fails([{ name: 'a', value: { shoes: [{ reveal: null }] } }], /a: an entry of "shoes" is not a shoe record/);
    fails([{ name: 'a', value: { kept: dt.kept, pairs: [{ gameId: 'x' }], seed: dt.pair } }], /a: an entry of "pairs" is not a kept pair/);
    fails([{ name: 'a', value: { kept: [] } }], /a: "kept" is not an object/);
    fails([{ name: 'a', value: { proofs: {} } }], /a: "proofs" is not an array/);
    fails([{ name: 'a', value: [[dt.proofs[0]]] }], /an array inside an array/);
    fails([{ name: 'a', value: [{ proofs: dt.proofs }] }], /a bundle inside an array/);
    fails([{ name: 'a', value: { records: { seedId: 'x', proofs: [1] } } }], /a record list needs/);
    fails(
      [
        { name: 'a', value: { kept: dt.kept, seed: dt.pair } },
        { name: 'b', value: { kept: { ...dt.kept, clientSeed: 'other' } } },
      ],
      /b: a second kept pair that differs from the one in a: verify one pair at a time/,
    );
    fails(
      [
        { name: 'a', value: dt.proofs[0] },
        { name: 'b', value: { ...dt.proofs[0], at: 1 } },
      ],
      /b: proof pf_vectordragon01 differs from the one in a/,
    );
    fails([{ name: 'a', value: { kept: dt.kept, own: dtOwn, note: 'mine' } }], /nothing to verify/);
    // The same record with its keys in another order is the same record.
    const reordered = Object.fromEntries(Object.entries(dt.proofs[0] as Record<string, unknown>).reverse());
    expect(collect([{ name: 'a', value: dt.proofs[0] }, { name: 'b', value: reordered }]).proofs).toHaveLength(1);
  });
});
