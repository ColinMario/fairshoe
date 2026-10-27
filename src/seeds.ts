/**
 * Seed pairs and the round stream (SPEC.md sections 2 and 4). The server seed is 32 random bytes, written as 64
 * lower-case hex digits; its commitment is SHA-256 over the 32 bytes. Each step of a game that draws takes one nonce
 * of the active pair and reads the round stream of that nonce from the start.
 */
import { fromHex, isHex, toHex } from './bytes.ts';
import { checkInputs, message } from './domains.ts';
import { sha256 } from './sha256.ts';
import { HmacStream, tapeRng, type TapeRng } from './stream.ts';

export function isServerSeed(value: unknown): value is string {
  return isHex(value, 32);
}

/** A server seed from 32 random bytes (the caller's cryptographic source). */
export function serverSeedFrom(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new Error('fairshoe: a server seed needs 32 random bytes');
  return toHex(bytes);
}

/** SHA-256 over the 32 bytes of the server seed, hex: published before the seed is used. */
export function serverSeedHash(serverSeed: string): string {
  if (!isServerSeed(serverSeed)) throw new Error('fairshoe: bad server seed');
  return toHex(sha256(fromHex(serverSeed)));
}

/** The word stream of one nonce. */
export function roundStream(serverSeed: string, gameId: string, clientSeed: string, nonce: number): HmacStream {
  if (!isServerSeed(serverSeed)) throw new Error('fairshoe: bad server seed');
  checkInputs({ gameId, clientSeed, counter: nonce });
  return new HmacStream(fromHex(serverSeed), (b) => message.stream(gameId, clientSeed, nonce, b));
}

/** `Rng { int(n) }` over the round stream of one nonce, recording its draws. */
export function roundRng(serverSeed: string, gameId: string, clientSeed: string, nonce: number): TapeRng {
  return tapeRng(roundStream(serverSeed, gameId, clientSeed, nonce));
}
