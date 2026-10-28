/** Persistent real-server vectors: independent public replay, without importing any private game implementation. */
import { collect, verifyBundle } from '../bin/report.ts';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from './harness.ts';
import { verifyPair, verifyRound, type PairSeen, type PlayerRecords, type RoundProof, type SeedReveal, type ShoeRecord } from '../src/index.ts';
interface Case { name: string; pair: PairSeen; seed: SeedReveal; proofs: RoundProof[]; shoes: ShoeRecord[]; own: PlayerRecords }
const cases = ['g9.json', 'g9-blackjack.json'].flatMap((name) => (JSON.parse(readFileSync(new URL(`../vectors/${name}`, import.meta.url), 'utf8')) as { cases: Case[] }).cases);
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('versioned payout vectors', () => {
  for (const c of cases) it(`${c.name}: every genuine paid round and its carried state are provable`, () => {
    const pair = verifyPair(c.seed, c.proofs, c.shoes, { pair: c.pair, own: c.own, prior: c.proofs });
    expect(pair.errors).toEqual([]); expect(pair.provable).toBe(true);
    for (const p of c.proofs.filter((p) => p.roundId !== null)) {
      const result = verifyRound(p, c.seed.serverSeed, { pair: c.pair, own: c.own, shoes: c.shoes, prior: c.proofs });
      expect(result.errors).toEqual([]); expect(result.provable).toBe(true); expect(result.outcome.payoutsChecked).toBe(true);
    }
  });

  it('the offline report preserves witness/carry data and separately checks current shoe records', () => {
    for (const c of cases) {
      const report = verifyBundle(collect([{ name: c.name, value: { kept: c.pair, seed: c.seed, own: c.own, proofs: c.proofs, shoes: c.shoes, prior: c.proofs } }]));
      expect(report.checks.filter((c) => c.status === 'failed')).toEqual([]);
      expect(report.provable).toBe(true);
      expect(report.checks.some((c) => c.kind === 'proof' && c.label.includes('payouts checked:'))).toBe(true);
    }
  });

  it('a changed card, strike, payout, commission, board or earned carry cannot pass', () => {
    for (const c of cases) {
      const p = c.proofs.find((p) => p.roundId !== null)!;
      const altered = copy(p), outcome = altered.outcome as Record<string, unknown>, detail = outcome.detail as Record<string, unknown> | undefined;
      if (c.name === 'hilo-rounded') detail!.payout = Number(detail!.payout) + 1;
      else if (c.name === 'trading-carry') detail!.carryAfter = (Number(detail!.carryAfter) + 1) % 100;
      else if (detail?.payoutProof) (detail.payoutProof as Record<string, unknown>).returned = Number((detail.payoutProof as Record<string, unknown>).returned) + 1;
      else outcome.totalWin = Number(outcome.totalWin) + 1;
      expect(verifyRound(altered, c.seed.serverSeed, { pair: c.pair, own: c.own, shoes: c.shoes, prior: c.proofs }).ok).toBe(false);
    }
    const c = cases.find((c) => c.name === 'blitz-baccarat-max')!, p = copy(c.proofs.find((p) => p.roundId !== null)!);
    const detail = (p.outcome as { detail: { strikes: Array<{ multiplier: number }> } }).detail;
    detail.strikes[0]!.multiplier++;
    expect(verifyRound(p, c.seed.serverSeed, { pair: c.pair, own: c.own, shoes: c.shoes }).ok).toBe(false);
    const bj = cases.find((c) => c.name === 'blitz-solo')!, b = copy(bj.proofs.find((p) => p.roundId !== null)!);
    (b.outcome as { payoutProof: { board: Record<string, number> } }).payoutProof.board.bj!++;
    expect(verifyRound(b, bj.seed.serverSeed, { pair: bj.pair, own: bj.own, shoes: bj.shoes, prior: bj.proofs }).ok).toBe(false);
  });

  it('an earned multiplier cannot disappear from the next visible board, including a one-cent-correct ordinary payout', () => {
    const c = cases.find((c) => c.name === 'blitz-solo')!, proof = copy(c.proofs.find((p) => p.roundId === '1-3')!), own = copy(c.own);
    const witness = own.gameplay![proof.roundId!]; if (witness?.kind !== 'blackjack/payout-v1') throw new Error('bad vector');
    witness.boxes[0]!.pending = null;
    const result = proof.outcome as { totalWin: number; hands: Array<{ payout: number; multiplier?: number }> };
    result.hands[0]!.payout = 1252; delete result.hands[0]!.multiplier; result.totalWin = 1252;
    const checked = verifyRound(proof, c.seed.serverSeed, { pair: c.pair, own, shoes: c.shoes, prior: c.proofs });
    expect(checked.ok).toBe(false); expect(checked.errors.some((e) => e.includes('carried multiplier'))).toBe(true);
    delete witness.carryFrom; witness.carryKnown = false;
    expect(verifyRound(proof, c.seed.serverSeed, { pair: c.pair, own, shoes: c.shoes, prior: c.proofs }).provable).toBe(false);
  });

  it('a known open Trading Portfolio cannot be erased by showing only newly placed chips', () => {
    const c = cases.find((c) => c.name === 'trading-carry')!, proof = copy(c.proofs[1]!), own = copy(c.own);
    const witness = own.gameplay![proof.roundId!]; if (witness?.kind !== 'trading/carry99-v1') throw new Error('bad vector');
    witness.value = witness.chips = witness.staked = 31; delete witness.portfolioFrom;
    const detail = (proof.outcome as { detail: Record<string, unknown> }).detail; detail.before = 31; detail.after = 15; detail.chips = 31;
    const checked = verifyRound(proof, c.seed.serverSeed, { pair: c.pair, own, prior: c.proofs });
    expect(checked.ok).toBe(false); expect(checked.errors.some((e) => e.includes('Portfolio continuity'))).toBe(true);
  });

  it('extra draws and wrong input kinds cannot switch payout validation off', () => {
    const c = cases.find((c) => c.name === 'hilo-rounded')!, p = copy(c.proofs.find((p) => p.roundId !== null)!);
    p.steps.at(-1)!.draws.push({ n: 52, v: 0 });
    expect(verifyRound(p, c.seed.serverSeed, { pair: c.pair, own: c.own }).ok).toBe(false);
    const own = copy(c.own); own.gameplay![p.roundId!]!.complete = false;
    expect(verifyRound(c.proofs.find((x) => x.roundId === p.roundId)!, c.seed.serverSeed, { pair: c.pair, own })).toMatchObject({ ok: true, provable: false });
  });

  it('missing, conflicting and cyclic carry predecessors never become trusted state', () => {
    const c = cases.find((c) => c.name === 'trading-carry')!, last = c.proofs.at(-1)!;
    expect(verifyRound(last, c.seed.serverSeed, { pair: c.pair, own: c.own })).toMatchObject({ ok: true, provable: false });
    const conflict = copy(c.proofs[0]!); (conflict.outcome as { detail: { carryAfter: number } }).detail.carryAfter++;
    expect(verifyPair(c.seed, c.proofs, c.shoes, { pair: c.pair, own: c.own, prior: [conflict] }).ok).toBe(false);
    const own = copy(c.own), w = own.gameplay![last.roundId!];
    if (!w || w.kind !== 'trading/carry99-v1') throw new Error('bad vector');
    w.carryFrom = { seedId: last.seedId, roundId: last.roundId! };
    expect(verifyRound(last, c.seed.serverSeed, { pair: c.pair, own, prior: c.proofs }).ok).toBe(false);
  });

  it('malformed lounge envelopes return a failed check instead of throwing', () => {
    for (const value of [{ gameId: 'lounge-bali-1', lounge: {} }, { gameId: 5 }]) {
      expect(verifyRound(value as unknown as RoundProof).ok).toBe(false);
    }
  });

  it('historical blackjack records stay arithmetically valid but never claim checked payouts', () => {
    const c = cases.find((c) => c.name === 'solo-classic')!, proof = copy(c.proofs.find((p) => p.roundId)!);
    delete (proof.outcome as { payoutProof?: unknown }).payoutProof;
    const own = copy(c.own); delete own.gameplay;
    const result = verifyRound(proof, c.seed.serverSeed, { pair: c.pair, own, shoes: c.shoes });
    expect(result.ok).toBe(true); expect(result.outcome.payoutsChecked).toBe(false);
  });
});
