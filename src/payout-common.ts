import type { RoundProof, StepProof } from './records.ts';
import type { DrawAuthorization, GameplayState, GameplayWitness, ProofRef } from './gameplay.ts';
export interface PriorState { verified: boolean; state?: GameplayState }
export interface PayoutContext {
  gameplay?: GameplayWitness;
  authorizedDraws?: Readonly<Record<string, DrawAuthorization>>;
  baccaratNonce?: number;
  baccaratSeedId?: string;
  shoeKinds?: readonly ('free' | 'deal' | 'unknown')[];
  /** A guard-approved board recorded by this client before and during the hand. */
  baccaratBets?: Readonly<Record<string, number>>;
  prior?: Readonly<Record<string, PriorState>>;
}
export const proofRefKey = (r: ProofRef): string => `${r.seedId}:${r.roundId}`;
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]));
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const keys = Object.keys(x).sort(), others = Object.keys(y).sort();
  return keys.length === others.length && keys.every((key, i) => key === others[i] && equal(x[key], y[key]));
}
export const integer = (n: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
export function detailRecord(proof: RoundProof): Record<string, unknown> | null {
  const outcome = proof.outcome as { detail?: unknown } | null;
  return outcome?.detail && typeof outcome.detail === 'object' && !Array.isArray(outcome.detail) ? outcome.detail as Record<string, unknown> : null;
}
export class UnprovenPayoutError extends Error {}

export function drawingSteps(proof: RoundProof, startNonce: number): StepProof[] {
  if (!integer(startNonce)) throw new Error('invalid first-round nonce');
  const following = proof.steps.filter((s) => s.nonce >= startNonce);
  if (following.some((s) => s.status === 'discarded')) throw new UnprovenPayoutError('a random step after the player nonce anchor was discarded; its use is not bound to an acknowledged action');
  const drawing = following.filter((s) => s.status === 'ok' && s.draws.length > 0);
  if (drawing.some((s, index) => s.nonce !== startNonce + index)) throw new UnprovenPayoutError('the payout draw nonces do not start at the player nonce anchor without gaps');
  return drawing;
}
export class PayoutTape {
  private at = 0;
  private readonly step: StepProof;
  constructor(step: StepProof) { this.step = step; }
  int(n: number): number {
    const d = this.step.draws[this.at++];
    if (!d || d.n !== n || !integer(d.v, 0, n - 1)) throw new Error(`nonce ${this.step.nonce}: expected payout draw int(${n}) at ${this.at - 1}`);
    return d.v;
  }
  finish(): void { if (this.at !== this.step.draws.length) throw new Error(`nonce ${this.step.nonce}: extra draws after the payout plan`); }
}
export function requireEqual(errors: string[], what: string, got: unknown, expected: unknown): void {
  if (!equal(got, expected)) errors.push(`${what}: expected ${JSON.stringify(expected)}, record says ${JSON.stringify(got)}`);
}

/** A server nonce announcement cannot authorize randomness; only acknowledged player operations can. */
export function authorizedSteps(proof: RoundProof, context: PayoutContext, allowed: readonly DrawAuthorization['kind'][]): StepProof[] {
  if (proof.steps.some((s) => s.status === 'discarded')) throw new UnprovenPayoutError('a random step was discarded; the full player-authorized draw sequence is not provable');
  if (proof.steps.some((s) => s.status === 'ok' && s.draws.length === 0)) throw new UnprovenPayoutError('an empty applied random step consumes a nonce without an authorized draw');
  const drawing = proof.steps.filter((s) => s.status === 'ok' && s.draws.length > 0);
  for (const step of drawing) {
    const auth = context.authorizedDraws?.[String(step.nonce)];
    if (!auth) throw new UnprovenPayoutError(`nonce ${step.nonce} has no player-owned draw authorization`);
    if (!allowed.includes(auth.kind)) throw new Error(`nonce ${step.nonce}: player authorized ${auth.kind}, not this game's draw`);
  }
  return drawing;
}
