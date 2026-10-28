import { describe, it } from './harness.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { quicknetRandomness, quicknetRoundAfter, quicknetRoundTime, verifyQuicknetBeacon, QUICKNET_CHAIN_HASH, QUICKNET_GENESIS_SECONDS, QUICKNET_PERIOD_SECONDS, QUICKNET_PUBLIC_KEY } from '../src/quicknet.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/quicknet/round-1.json', import.meta.url), 'utf8'));
const beacon = { ...fixture, randomness: quicknetRandomness(fixture.signature) };
describe('pinned quicknet verification', () => {
  it('verifies the independently downloaded official round-one signature', () => {
    const chain = JSON.parse(readFileSync(new URL('./fixtures/quicknet/chain.json', import.meta.url), 'utf8'));
    assert.equal(chain.chain_hash, QUICKNET_CHAIN_HASH); assert.equal(chain.public_key, QUICKNET_PUBLIC_KEY);
    assert.equal(chain.genesis_time, QUICKNET_GENESIS_SECONDS); assert.equal(chain.period, QUICKNET_PERIOD_SECONDS);
    assert.equal(verifyQuicknetBeacon(beacon), true);
    assert.equal(beacon.randomness, createHash('sha256').update(Buffer.from(beacon.signature, 'hex')).digest('hex'));
  });
  it('rejects a changed round, invalid point, infinity, changed randomness and malformed input', () => {
    for (const value of [
      { ...beacon, round: 2 }, { ...beacon, round: 0 }, { ...beacon, round: 1.5 },
      { ...beacon, signature: '0'.repeat(96), randomness: quicknetRandomness('0'.repeat(96)) },
      { ...beacon, signature: 'c0' + '00'.repeat(47), randomness: quicknetRandomness('c0' + '00'.repeat(47)) },
      { ...beacon, randomness: '0'.repeat(64) }, { ...beacon, signature: beacon.signature.slice(2) },
    ]) assert.equal(verifyQuicknetBeacon(value), false);
  });
  it('fixes the first strictly future round at betting close', () => {
    const start = QUICKNET_GENESIS_SECONDS * 1000;
    assert.equal(quicknetRoundAfter(start - 1), 1); assert.equal(quicknetRoundAfter(start), 2);
    assert.equal(quicknetRoundAfter(start + 2999), 2); assert.equal(quicknetRoundAfter(start + 3000), 3);
    assert.equal(quicknetRoundTime(2), start + 3000);
  });
  it('the vendored arithmetic runs in a bare ECMAScript context and matches the pinned source hash', () => {
    const source = readFileSync(new URL('../src/vendor/noble-g1.ts', import.meta.url), 'utf8');
    const manifest = JSON.parse(readFileSync(new URL('../src/vendor/noble-manifest.json', import.meta.url), 'utf8'));
    assert.equal(createHash('sha256').update(source).digest('hex'), manifest.generatedSha256);
    const sandbox = createContext({ signature: Array.from(Buffer.from(beacon.signature, 'hex')),
      publicKey: Array.from(Buffer.from(QUICKNET_PUBLIC_KEY, 'hex')),
      message: Array.from(createHash('sha256').update(Buffer.from('0000000000000001', 'hex')).digest()) });
    runInContext(source.replace('export function nobleVerifyG1(', 'function nobleVerifyG1('), sandbox);
    assert.equal(runInContext('nobleVerifyG1(Uint8Array.from(signature), Uint8Array.from(message), Uint8Array.from(publicKey))', sandbox), true);
    assert.equal(runInContext('[typeof process, typeof require, typeof Buffer, typeof crypto, typeof TextEncoder].join()', sandbox), 'undefined,undefined,undefined,undefined,undefined');
  });
});
