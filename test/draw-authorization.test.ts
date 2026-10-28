/** Cryptographically valid cherry-picking attempts, including operations hidden before the claimed nonce anchor. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from './harness.ts';
import { ALG, LIB, roundRng, serverSeedHash, verifyRound, verifyPair, type PairSeen, type PlayerRecords, type RoundProof, type SeedReveal, type ShoeRecord, type StepProof } from '../src/index.ts';
const seed = '00'.repeat(32), clientSeed = 'draw-plan-audit', gameId = 'bull-run';
const pair: PairSeen = { seedId: 'S', gameId, serverSeedHash: serverSeedHash(seed), root: null, clientSeed, clientSeedBy: 'player', committedAt: 1, clientSeedAt: 2 };
function step(nonce: number, status: 'ok'|'discarded' = 'ok'): StepProof {
  const rng = roundRng(seed, gameId, clientSeed, nonce); rng.int(990); rng.int(0x1_0000_0000);
  return { nonce, kind: 'act', status, draws: [...rng.draws], words: rng.words };
}
function trade(steps: StepProof[], anchor: number) {
  const selected = steps.at(-1)!, u = selected.draws[0]!.v, z = u % 495;
  const move = (u < 495 ? 1 : -1) * (z < 99 ? 100 : 1 + Math.floor((z - 99) / 4));
  const after = 100 + move, fee = Math.floor((99 + after) / 100), payout = after - fee;
  const proof: RoundProof = { v: 1, alg: ALG, lib: LIB, id: 'proof-audit', gameId, roundId: 'R', seedId: 'S', serverSeedHash: pair.serverSeedHash, clientSeed, clientSeedBy: 'player', serverSeed: seed, steps, shoes: [], outcome: { detail: { mapping: 'trading/carry99-v1', side: 'up', move, seed: selected.draws[1]!.v, before: 100, after, ride: false, ...(after > 0 ? { cashout: { value: after, fee, payout, by: 'auto' } } : {}), carryBefore: 99, carryAfter: after > 0 ? (99 + after) % 100 : 99, staked: 100, chips: 100, refunded: 0 } }, engineVersion: 1, at: 100 };
  const own: PlayerRecords = { authorizedDraws: { S: { [String(anchor)]: { kind: 'trading-trade' } } }, gameplay: { R: { kind: 'trading/carry99-v1', complete: true, operation: 'trade', value: 100, chips: 100, staked: 100, side: 'up', ride: false, startNonce: anchor, carry: 99, carryKnown: true } } };
  return { proof, own };
}
interface Case { name: string; pair: PairSeen; seed: SeedReveal; proofs: RoundProof[]; shoes: ShoeRecord[]; own: PlayerRecords }
const cases = (JSON.parse(readFileSync(new URL('../vectors/g9.json', import.meta.url), 'utf8')) as { cases: Case[] }).cases;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('own full RNG authorization', () => {
  it('accepts the first actual acknowledged trade', () => {
    const { proof, own } = trade([step(0)], 0);
    expect(verifyRound(proof, seed, { pair, own })).toMatchObject({ ok: true, provable: true, outcome: { payoutsChecked: true } });
  });
  it('does not certify a losing discarded draw followed by a selected win, before or after the anchor', () => {
    expect(step(0).draws[0]!.v).toBe(938); expect(step(1).draws[0]!.v).toBe(159);
    for (const anchor of [0, 1]) {
      const { proof, own } = trade([step(0, 'discarded'), step(1)], anchor);
      expect(verifyRound(proof, seed, { pair, own })).toMatchObject({ ok: true, provable: false, outcome: { payoutsChecked: false } });
    }
  });
  it('does not let an unacknowledged applied or empty prefix hide behind fair_get nonce one', () => {
    for (const prefix of [step(0), { ...step(0), draws: [], words: 0 }]) {
      const { proof, own } = trade([prefix, step(1)], 1);
      const check = verifyRound(proof, seed, { pair, own });
      expect(check.provable).toBe(false); expect(check.outcome.payoutsChecked).toBe(false);
    }
  });
  it('rejects moving a real trade to an idle proof or substituting another operation authorization', () => {
    const { proof, own } = trade([step(0)], 0);
    expect(verifyRound({ ...proof, roundId: null, outcome: null }, seed, { pair, own }).ok).toBe(false);
    const wrong = copy(own); wrong.authorizedDraws = { S: { '0': { kind: 'blackjack-board' } } };
    expect(verifyRound(proof, seed, { pair, own: wrong }).ok).toBe(false);
  });
  it('requires the actual observed Hi-Lo init/exchange and guess cards, including prefixes', () => {
    const c = cases.find((c) => c.name === 'hilo-rounded')!, p = c.proofs.find((p) => p.roundId)!;
    const missing = copy(c.own); delete missing.authorizedDraws;
    expect(verifyRound(p, c.seed.serverSeed, { pair: c.pair, own: missing, prior: c.proofs })).toMatchObject({ ok: true, provable: false, outcome: { payoutsChecked: false } });
    const wrong = copy(c.own), first = Object.keys(wrong.authorizedDraws![p.seedId]!)[0]!;
    const auth = wrong.authorizedDraws![p.seedId]![first]!; auth.card = auth.card === 'AS' ? 'KS' : 'AS';
    expect(verifyRound(p, c.seed.serverSeed, { pair: c.pair, own: wrong, prior: c.proofs }).ok).toBe(false);
  });
  it('requires acknowledged multiplier free-hand randomness and exact paid-hand nonce receipts', () => {
    const c = cases.find((c) => c.name === 'blitz-baccarat-max')!, own = copy(c.own);
    const freeNonce = Object.keys(own.authorizedDraws![c.pair.seedId]!).find((n) => own.authorizedDraws![c.pair.seedId]![n]!.kind === 'baccarat-free')!;
    delete (own.authorizedDraws![c.pair.seedId] as Record<string, unknown>)[freeNonce];
    expect(verifyPair(c.seed, c.proofs, c.shoes, { pair: c.pair, own }).provable).toBe(false);
    const paid = c.proofs.find((p) => p.roundId)!, changed = copy(c.own);
    const decisions = Object.values(changed.refused!).flat(); decisions[0]!.startNonce = 0;
    expect(verifyRound(paid, c.seed.serverSeed, { pair: c.pair, own: changed, shoes: c.shoes }).ok).toBe(false);
  });
});
