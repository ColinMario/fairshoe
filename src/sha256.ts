/**
 * SHA-256 (FIPS 180-4) and HMAC-SHA256 (RFC 2104) in plain TypeScript: synchronous, no dependencies, the same in
 * Node, browsers and workers. The tests check both against node:crypto and the RFC 4231 vectors.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);

/** Message schedule, shared by all instances (the hash is synchronous, so no two blocks are ever in flight). */
const W = new Uint32Array(64);

function compress(state: Uint32Array, block: Uint8Array, offset: number): void {
  for (let i = 0; i < 16; i++) {
    const j = offset + i * 4;
    W[i] = ((block[j]! << 24) | (block[j + 1]! << 16) | (block[j + 2]! << 8) | block[j + 3]!) >>> 0;
  }
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15]!;
    const b = W[i - 2]!;
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) >>> 0;
  }
  let a = state[0]!;
  let b = state[1]!;
  let c = state[2]!;
  let d = state[3]!;
  let e = state[4]!;
  let f = state[5]!;
  let g = state[6]!;
  let h = state[7]!;
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[i]! + W[i]!) >>> 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  state[0] = (state[0]! + a) >>> 0;
  state[1] = (state[1]! + b) >>> 0;
  state[2] = (state[2]! + c) >>> 0;
  state[3] = (state[3]! + d) >>> 0;
  state[4] = (state[4]! + e) >>> 0;
  state[5] = (state[5]! + f) >>> 0;
  state[6] = (state[6]! + g) >>> 0;
  state[7] = (state[7]! + h) >>> 0;
}

/** Incremental SHA-256. */
export class Sha256 {
  private readonly state = new Uint32Array(H0);
  private readonly buffer = new Uint8Array(64);
  private filled = 0;
  /** Bytes hashed so far (messages here are far below 2^53 bytes). */
  private length = 0;
  private done = false;

  update(data: Uint8Array): this {
    if (this.done) throw new Error('sha256: update after digest');
    let i = 0;
    this.length += data.length;
    if (this.filled > 0) {
      const take = Math.min(64 - this.filled, data.length);
      this.buffer.set(data.subarray(0, take), this.filled);
      this.filled += take;
      i = take;
      if (this.filled < 64) return this;
      compress(this.state, this.buffer, 0);
      this.filled = 0;
    }
    for (; i + 64 <= data.length; i += 64) compress(this.state, data, i);
    if (i < data.length) {
      this.buffer.set(data.subarray(i), 0);
      this.filled = data.length - i;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.done) throw new Error('sha256: digest twice');
    this.done = true;
    const bits = this.length * 8;
    const buf = this.buffer;
    buf[this.filled++] = 0x80;
    if (this.filled > 56) {
      buf.fill(0, this.filled);
      compress(this.state, buf, 0);
      this.filled = 0;
    }
    buf.fill(0, this.filled, 56);
    const high = Math.floor(bits / 0x1_0000_0000);
    const low = bits >>> 0;
    buf[56] = high >>> 24;
    buf[57] = (high >>> 16) & 0xff;
    buf[58] = (high >>> 8) & 0xff;
    buf[59] = high & 0xff;
    buf[60] = low >>> 24;
    buf[61] = (low >>> 16) & 0xff;
    buf[62] = (low >>> 8) & 0xff;
    buf[63] = low & 0xff;
    compress(this.state, buf, 0);
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      const v = this.state[i]!;
      out[i * 4] = v >>> 24;
      out[i * 4 + 1] = (v >>> 16) & 0xff;
      out[i * 4 + 2] = (v >>> 8) & 0xff;
      out[i * 4 + 3] = v & 0xff;
    }
    return out;
  }

  /** A copy of the running state (HMAC keeps the keyed inner and outer states and copies them per message). */
  clone(): Sha256 {
    const c = new Sha256();
    c.state.set(this.state);
    c.buffer.set(this.buffer);
    c.filled = this.filled;
    c.length = this.length;
    c.done = this.done;
    return c;
  }
}

/** SHA-256 of `data` (32 bytes). */
export function sha256(data: Uint8Array): Uint8Array {
  return new Sha256().update(data).digest();
}

/**
 * HMAC-SHA256 with a fixed key. The key's inner and outer pads are hashed once; each message then costs only its
 * own blocks plus one outer block (the shoe and round streams compute thousands of messages under one key).
 */
export class HmacSha256 {
  private readonly inner: Sha256;
  private readonly outer: Sha256;

  constructor(key: Uint8Array) {
    const block = new Uint8Array(64);
    block.set(key.length > 64 ? sha256(key) : key);
    const pad = new Uint8Array(64);
    for (let i = 0; i < 64; i++) pad[i] = block[i]! ^ 0x36;
    this.inner = new Sha256().update(pad);
    for (let i = 0; i < 64; i++) pad[i] = block[i]! ^ 0x5c;
    this.outer = new Sha256().update(pad);
  }

  mac(message: Uint8Array): Uint8Array {
    const inner = this.inner.clone().update(message).digest();
    return this.outer.clone().update(inner).digest();
  }
}

/** HMAC-SHA256(key, message), 32 bytes. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  return new HmacSha256(key).mac(message);
}
