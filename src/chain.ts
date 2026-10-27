/**
 * Hash chains for shoes (SPEC.md section 5). One chain per player, game and table: from a secret s of 32 random bytes,
 * link i = SHA-256^(N - i)(s) for i = 0 ... N. Link 0 (the terminal hash) is published before the client seed; shoe
 * number i of the table is shuffled under link i (i >= 1), and SHA-256(link i) = link i - 1. Revealing link i at the
 * end of shoe i opens that shoe (and the earlier ones, already open) but never a later shoe of any table.
 * The terminal hashes of all tables of a seed pair are bound in one root, published with the pair's hash.
 */
import { toHex, utf8 } from './bytes.ts';
import { checkInputs, type TableRef } from './domains.ts';
import { sha256 } from './sha256.ts';

/** Default chain length: shoes per table and seed pair. */
export const CHAIN_LENGTH = 2000;

/**
 * A SHA-256 implementation (bytes in, 32 bytes out). Chains take thousands of hashes, so a server may pass a native
 * one (node:crypto); the result is the same as the package's own `sha256`.
 */
export type Sha256Fn = (data: Uint8Array) => Uint8Array;

/** Link `index` of the chain of `secret` with `length` links after the terminal: SHA-256 applied length - index times. */
export function chainLink(secret: Uint8Array, length: number, index: number, hash: Sha256Fn = sha256): Uint8Array {
  if (secret.length !== 32) throw new Error('fairshoe: a chain secret has 32 bytes');
  if (!Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(index) || index < 0 || index > length) {
    throw new Error('fairshoe: bad chain index');
  }
  let h = secret;
  for (let k = 0; k < length - index; k++) h = hash(h);
  return h === secret ? secret.slice() : h;
}

/** Link 0, published before the first shoe. */
export function chainTerminal(secret: Uint8Array, length: number, hash: Sha256Fn = sha256): Uint8Array {
  return chainLink(secret, length, 0, hash);
}

/** Hashing `link` `steps` times gives `target` (link i, i steps -> the terminal; 1 step -> link i - 1). */
export function linkReaches(link: Uint8Array, steps: number, target: string, hash: Sha256Fn = sha256): boolean {
  if (!Number.isSafeInteger(steps) || steps < 0) return false;
  let h = link;
  for (let k = 0; k < steps; k++) h = hash(h);
  return toHex(h) === target;
}

/** One line of a shoe root: `{gameId}:{table}:{terminal hex}`. */
export function rootLine(gameId: string, table: TableRef, terminal: string): string {
  checkInputs({ gameId, table });
  return `${gameId}:${table}:${terminal}`;
}

/**
 * The root over the terminal hashes of a seed pair's chains: SHA-256 of the lines sorted by their UTF-8 bytes (all
 * lines are ASCII, so that is the plain code unit order: "baccarat:10:..." before "baccarat:1:..."), joined with '\n'.
 */
export function shoeRoot(lines: readonly string[]): { hash: string; lines: string[] } {
  const sorted = [...lines].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { hash: toHex(sha256(utf8(sorted.join('\n')))), lines: sorted };
}
