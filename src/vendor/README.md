# Pinned BLS verification implementation

`noble-g1.ts` is a generated, self-contained signature-verification closure from MIT-licensed
[`@noble/curves` 2.4.0](https://github.com/paulmillr/noble-curves/releases/tag/2.4.0) and
[`@noble/hashes` 2.4.0](https://github.com/paulmillr/noble-hashes/releases/tag/2.4.0).
The complete license notices are retained next to the source. `noble-manifest.json` records package archive
SHA-512 integrity, each included original source SHA-256, the generated file hash and the UTF-8 adapter hash.

The only public operation is short BLS12-381 signature verification on G1 with public keys on G2. No key generation,
signing, network or platform cryptography API is exposed or used. Upstream arithmetic is unchanged. The build
substitutes the library's existing pure UTF-8 encoder for TextEncoder so the result runs in bare ECMAScript.
The unreachable random-generation helper is replaced with an always-throwing adapter; no platform randomness
is present, and no cryptographic arithmetic is altered.
The official quicknet round-one signature and hostile inputs are tested independently in `test/quicknet.test.ts`.

From the application repository, reproduce with `node tools/vendor-noble.mjs <noble-source-directory>` after
downloading the two named archives with `npm pack --ignore-scripts` and extracting each under `curves/package/`
and `hashes/package/`. The build checks archive integrity and compares every consumed source file with the archive.
The published fairshoe package requires no installation or downloads to verify signatures.

Protocol reference: [drand's signature verification](https://github.com/drand/drand-client/blob/master/lib/beacon-verification.ts).
Quicknet uses SHA-256 of the big-endian uint64 round and the RFC9380 G1 signature domain. The chain hash, key,
genesis and period are pinned in `quicknet.ts`; the verifier never accepts a key supplied by an untrusted relay.
