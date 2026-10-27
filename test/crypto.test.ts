/** The plain TypeScript SHA-256 / HMAC-SHA256 against node:crypto, Web Crypto and RFC 4231. */
import { createHash, createHmac, randomBytes, webcrypto } from 'node:crypto';
import { describe, expect, it } from './harness.ts';
import { fromHex, HmacSha256, hmacSha256, isHex, Sha256, sha256, toHex, utf8 } from '../src/index.ts';

const nodeSha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const nodeHmac = (k: Uint8Array, m: Uint8Array): string => createHmac('sha256', k).update(m).digest('hex');

describe('SHA-256', () => {
  it('matches node:crypto for every length from 0 to 300 bytes and for long inputs', () => {
    for (let n = 0; n <= 300; n++) {
      const data = randomBytes(n);
      expect(toHex(sha256(data))).toBe(nodeSha(data));
    }
    const big = randomBytes(100_003);
    expect(toHex(sha256(big))).toBe(nodeSha(big));
  });

  it('gives the same digest however the input is split into updates', () => {
    const data = randomBytes(1000);
    for (const parts of [[1, 999], [63, 1, 936], [64, 64, 872], [55, 9, 0, 936], [999, 1]]) {
      const h = new Sha256();
      let at = 0;
      for (const p of parts) {
        h.update(data.subarray(at, at + p));
        at += p;
      }
      expect(toHex(h.digest())).toBe(nodeSha(data));
    }
  });

  it('knows the FIPS 180-4 examples', () => {
    expect(toHex(sha256(utf8('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(toHex(sha256(new Uint8Array(0)))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(toHex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });
});

describe('HMAC-SHA256', () => {
  it('matches node:crypto for keys shorter than, equal to and longer than a block', () => {
    for (const keyLength of [0, 1, 20, 32, 63, 64, 65, 131, 300]) {
      for (const messageLength of [0, 1, 55, 56, 64, 100, 1000]) {
        const key = randomBytes(keyLength);
        const msg = randomBytes(messageLength);
        expect(toHex(hmacSha256(key, msg))).toBe(nodeHmac(key, msg));
      }
    }
  });

  it('can reuse one keyed instance for many messages', () => {
    const key = randomBytes(32);
    const mac = new HmacSha256(key);
    for (let i = 0; i < 50; i++) {
      const msg = utf8(`fairshoe/v1/stream:roulette:seed:${i}:0`);
      expect(toHex(mac.mac(msg))).toBe(nodeHmac(key, msg));
    }
  });

  // RFC 4231 section 4: test cases 1 to 7 (case 5 is truncated to 128 bits).
  const cases: Array<{ key: Uint8Array; data: Uint8Array; mac: string }> = [
    { key: new Uint8Array(20).fill(0x0b), data: utf8('Hi There'), mac: 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7' },
    { key: utf8('Jefe'), data: utf8('what do ya want for nothing?'), mac: '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843' },
    { key: new Uint8Array(20).fill(0xaa), data: new Uint8Array(50).fill(0xdd), mac: '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe' },
    {
      key: Uint8Array.from({ length: 25 }, (_, i) => i + 1),
      data: new Uint8Array(50).fill(0xcd),
      mac: '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b',
    },
    { key: new Uint8Array(20).fill(0x0c), data: utf8('Test With Truncation'), mac: 'a3b6167473100ee06e0c796c2955552b' },
    {
      key: new Uint8Array(131).fill(0xaa),
      data: utf8('Test Using Larger Than Block-Size Key - Hash Key First'),
      mac: '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
    },
    {
      key: new Uint8Array(131).fill(0xaa),
      data: utf8(
        'This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.',
      ),
      mac: '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2',
    },
  ];
  it.each(cases.map((c, i) => [i + 1, c] as const))('RFC 4231 test case %i', (_, c) => {
    expect(toHex(hmacSha256(c.key, c.data)).slice(0, c.mac.length)).toBe(c.mac);
  });

  it('matches Web Crypto (crypto.subtle) for a stream block', async () => {
    const key = new Uint8Array(fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'));
    const msg = new Uint8Array(utf8('fairshoe/v1/stream:roulette:player-seed-01:0:0'));
    const k = await webcrypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await webcrypto.subtle.sign('HMAC', k, msg));
    expect(toHex(hmacSha256(key, msg))).toBe(toHex(sig));
  });
});

describe('bytes', () => {
  it('encodes UTF-8 like Buffer, including surrogate pairs and lone surrogates', () => {
    for (const s of ['', 'abc', 'Größe', '€', '𝄞 clef', 'a\ud800b', '\udfff', 'x'.repeat(1000)]) {
      expect(toHex(utf8(s))).toBe(Buffer.from(s, 'utf8').toString('hex'));
    }
  });

  it('round-trips hex and only accepts lower-case hex of an even length', () => {
    const b = randomBytes(40);
    expect(toHex(fromHex(toHex(b)))).toBe(toHex(b));
    expect(isHex('00ff')).toBe(true);
    expect(isHex('00FF')).toBe(false);
    expect(isHex('0')).toBe(false);
    expect(isHex('ab', 2)).toBe(false);
    expect(() => fromHex('xyz0')).toThrow();
  });
});
