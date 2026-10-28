/** Pinned drand quicknet (unchained RFC9380 signatures on G1), verified offline with no platform APIs. */
import { fromHex, toHex } from './bytes.ts';
import { sha256 } from './sha256.ts';
import { nobleVerifyG1 } from './vendor/noble-g1.ts';

export const QUICKNET_CHAIN_HASH = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
export const QUICKNET_PUBLIC_KEY = '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a';
export const QUICKNET_GENESIS_SECONDS = 1692803367;
export const QUICKNET_PERIOD_SECONDS = 3;
export interface QuicknetBeacon { round: number; signature: string; randomness: string }

export function quicknetRoundTime(round: number): number {
  if (!Number.isSafeInteger(round) || round < 1) throw new RangeError('invalid beacon round');
  const at = (QUICKNET_GENESIS_SECONDS + (round - 1) * QUICKNET_PERIOD_SECONDS) * 1000;
  if (!Number.isSafeInteger(at)) throw new RangeError('beacon time is out of range');
  return at;
}

/** The first scheduled round strictly after the fixed betting close, never a dynamically selected latest round. */
export function quicknetRoundAfter(closeAt: number): number {
  if (!Number.isSafeInteger(closeAt)) throw new RangeError('invalid close timestamp');
  return Math.max(1, Math.floor((closeAt - QUICKNET_GENESIS_SECONDS * 1000) / (QUICKNET_PERIOD_SECONDS * 1000)) + 2);
}

export function quicknetRandomness(signature: string): string {
  if (!/^[0-9a-f]{96}$/.test(signature)) throw new Error('invalid quicknet signature');
  return toHex(sha256(fromHex(signature)));
}

export function verifyQuicknetBeacon(beacon: QuicknetBeacon): boolean {
  try {
    if (!beacon || !Number.isSafeInteger(beacon.round) || beacon.round < 1 ||
        typeof beacon.signature !== 'string' || !/^[0-9a-f]{96}$/.test(beacon.signature) ||
        typeof beacon.randomness !== 'string' || beacon.randomness !== quicknetRandomness(beacon.signature)) return false;
    let round = BigInt(beacon.round);
    const encoded = new Uint8Array(8);
    for (let i = 7; i >= 0; i--) { encoded[i] = Number(round & 255n); round >>= 8n; }
    return nobleVerifyG1(fromHex(beacon.signature), sha256(encoded), fromHex(QUICKNET_PUBLIC_KEY));
  } catch { return false; }
}
