/**
 * The random stream of fairshoe/v1: HMAC-SHA256 blocks under one key, block b over the UTF-8 message message(b),
 * read as unsigned big-endian 32-bit words (8 per block). Integers in [0, n) by rejection sampling, so every value is
 * exactly equally likely; no floating point anywhere.
 */
import { utf8 } from './bytes.ts';
import { HmacSha256 } from './sha256.ts';

const TWO_32 = 0x1_0000_0000;

/** A source of uniform unsigned 32-bit words. */
export interface WordSource {
  next32(): number;
  /** Words read so far. */
  readonly words: number;
}

/** Words of HMAC-SHA256(key, message(b)) for b = 0, 1, 2, ... */
export class HmacStream implements WordSource {
  private readonly hmac: HmacSha256;
  private readonly message: (block: number) => string;
  private block: Uint8Array = new Uint8Array(0);
  private pos = 0;
  private b = 0;
  private count = 0;

  constructor(key: Uint8Array, message: (block: number) => string) {
    this.hmac = new HmacSha256(key);
    this.message = message;
  }

  get words(): number {
    return this.count;
  }

  /** Blocks computed so far. */
  get blocks(): number {
    return this.b;
  }

  next32(): number {
    if (this.pos >= this.block.length) {
      this.block = this.hmac.mac(utf8(this.message(this.b++)));
      this.pos = 0;
    }
    const k = this.block;
    const p = this.pos;
    this.pos += 4;
    this.count++;
    return ((k[p]! << 24) | (k[p + 1]! << 16) | (k[p + 2]! << 8) | k[p + 3]!) >>> 0;
  }
}

/** True for the range of int(n): an integer 1 <= n <= 2^32. */
export function isIntRange(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= TWO_32;
}

/**
 * Uniform integer in [0, n): n = 1 gives 0 without reading; otherwise words are read until one is below
 * limit = 2^32 - (2^32 mod n), and the result is that word mod n.
 */
export function uniformInt(source: WordSource, n: number): number {
  if (!isIntRange(n)) throw new RangeError(`int: n must be an integer in [1, 2^32], got ${String(n)}`);
  if (n === 1) return 0;
  const limit = TWO_32 - (TWO_32 % n);
  for (;;) {
    const w = source.next32();
    if (w < limit) return w % n;
  }
}

/** One draw of a stream: int(n) gave v. */
export interface Draw {
  n: number;
  v: number;
}

/** The interface of a game engine's random source (`Rng { int(n) }`) plus the tape of what was drawn. */
export interface TapeRng {
  int(n: number): number;
  /** Every draw in order (n = 1 included, it reads nothing). */
  readonly draws: readonly Draw[];
  /** Words read (draws plus rejected words). */
  readonly words: number;
}

export function tapeRng(source: WordSource): TapeRng {
  const draws: Draw[] = [];
  return {
    int(n: number): number {
      const v = uniformInt(source, n);
      draws.push({ n, v });
      return v;
    },
    draws,
    get words() {
      return source.words;
    },
  };
}
