# fairshoe

Provably fair random numbers and card shoes that a player can check: the algorithm `fairshoe/v1`
([SPEC.md](SPEC.md)), its reference implementation, test vectors from an independent implementation, a command line
verifier and a verifier page that works offline.

The library is plain TypeScript with its own SHA-256 and HMAC-SHA256, no dependencies and no platform API: the same
code runs in Node, in browsers and on a static page.

## How it works

Before the player chooses anything, the server commits to a server seed (its SHA-256) and, for card games, to one
hash chain per table (their terminal hashes form the root). The player keeps that commitment and sends a fresh client
seed of its own. Every random number of a round is `int(n)` on HMAC-SHA256 of the server seed over
`fairshoe/v1/stream:{game}:{client seed}:{nonce}:{block}`; every shoe is shuffled from a chain link and committed as
a salted hash before anyone can cut it. When the pair is rotated, the server reveals the seed and the links, and
everything can be recomputed.

The records prove only what they are bound to. What only the player knows has to come from the player's side:

- **kept**: the pair as it was shown before the client seed was sent (seed id, game, server seed hash, root,
  commitment time), with the client seed sent;
- **own**: the player's own records of the pair: the proofs and shoe commitments received, the nonce last seen
  before the rotation, the cuts asked for, the hands seen dealt, the table of each round.

Every check therefore ends in one of four states: **provable** (ok and bound to what the player kept), **ok** (the
records agree, but something only the player knows is missing, and the verifier lists it), **failed** (with the
reasons) or **pending** (not checkable yet: a shoe still in play, a proof whose pair is not revealed; what it binds
already, its pair, game, server seed hash and client seed, or its shoe's root and rules, is checked, and a
contradiction fails at once). A bundle is provable only when at least one shoe, proof or pair was checked and every
check is provable; when none could be checked yet it is pending. SPEC.md section 1 says what is proven and what is
not; section 8 lists every check.

## Requirements

Node.js 22.18 or newer, which runs TypeScript as it is. Nothing to install: run it from a checkout of this
repository (`git clone`, then `node bin/fairshoe-verify ...`). It is not meant to be installed as a package. Node
strips the types of no file under `node_modules`, so a copy installed there (from git or a tarball) cannot run; such
a copy of `bin/fairshoe-verify` says so and exits with 4. `main` and `exports` name the TypeScript sources for a
checkout, a workspace or a linked install (`npm install <path of the checkout>`, which links it), where Node runs
them as they are.

## Check a pair, a round or a shoe

`bin/fairshoe-verify` takes JSON files and checks everything in them together. A file holds a bundle:

```json
{
  "kept":    { "seedId": "...", "gameId": "...", "serverSeedHash": "...", "root": { "hash": "...", "lines": [] },
               "clientSeed": "...", "clientSeedBy": "player", "committedAt": 0, "clientSeedAt": 0 },
  "own":     { "proofs": [], "shoes": [], "nonce": 0, "cuts": {}, "hands": {}, "tables": {} },
  "seed":    { "...": "the pair's reveal" },
  "proofs":  [ "...round proofs" ],
  "shoes":   [ { "commit": {}, "reveal": {} } ],
  "pairs":   [ "...other kept pairs of the game" ],
  "later":   [ "...proofs of later pairs dealt from this pair's shoes" ],
  "records": { "seedId": "...", "gameId": "...", "proofs": [], "shoes": [] }
}
```

or one record as the server hands it out (a round proof, a shoe record, a reveal, a record list), or an array of
records. So the player's own file and the server's downloads can be passed side by side:

```sh
node bin/fairshoe-verify mine.json reveal.json proof-1.json proof-2.json shoe-1.json
```

**A whole pair**, after its rotation: the reveal, every proof and shoe, the kept pair and the own records.

```text
$ node bin/fairshoe-verify examples/dragon-tiger.json
fairshoe/v1 (fairshoe@1.1.0)
  provable  shoe sh_vectordragon01 (dragon-tiger table 1, shoe 1, shuffled, cut 200 by player, 3 hands)
  provable  proof pf_vectordragon01 (dragon-tiger round R-1, no nonce, outcome checked: dragon 8S, tiger 5S, dragon)
  provable  proof pf_vectordragon03 (dragon-tiger round R-2, no nonce, outcome checked: dragon 4C, tiger 10S, tiger)
  ok        reveal sd_vectordragon01 (dragon-tiger)
  provable  pair sd_vectordragon01 (dragon-tiger): 2 proofs, 0 steps, 1 shoe, 1 free hand
  provable  record list of pair sd_vectordragon01: 2 proofs, 1 shoe
result: provable
```

**A round**: its proof (it carries the server seed once the pair is revealed), the kept pair, and for a card game
the shoe it was dealt from. A proof whose server seed is not revealed yet is reported as pending.

```text
$ node bin/fairshoe-verify examples/baccarat-flipped-winner.json
fairshoe/v1 (fairshoe@1.1.0)
  provable  shoe sh_vectorbaccara1 (baccarat table 3, shoe 1, shuffled, cut 150 by player, 3 hands)
  FAILED    proof pf_vectorbaccara1 (baccarat round R-1, no nonce, outcome checked: player 2C QS 5C (7), banker 6C 10C (6), player)
              error: outcome: the winner is player, the proof says "banker"
  pending   pair sd_vectorbaccara1 (baccarat): not revealed yet, checkable after the rotation
result: FAILED (1 of 3 checks), 1 pending
```

**A shoe**: its commitment and reveal, the kept pair of its chain, and the cut and hands from the own records.
Without them the shoe is only ok:

```text
$ node bin/fairshoe-verify examples/dragon-tiger-without-own-records.json
fairshoe/v1 (fairshoe@1.1.0)
  ok        shoe sh_vectordragon01 (dragon-tiger table 1, shoe 1, shuffled, cut 200 by player, 3 hands)
              not provable: the cut the player asked for on this shoe is not given
              not provable: the hands the player saw dealt from this shoe are not given
  ...
result: ok, not provable
```

`--json` prints the report as JSON. The exit status is 0 for provable, 1 when a check failed, 2 for ok or pending
(not provable, nothing failed), 3 when the input could not be read and 4 when the verifier itself failed (a fault to
report, not a verdict on the records). `examples/` has a bundle for each case; each says what it shows in
its `note`.

## The library

```ts
import { verifyPair, verifyRound, verifySeedReveal, verifyShoe } from './src/index.ts';

// A round, once its pair is revealed (proof.serverSeed), against the pair kept before the client seed:
const round = verifyRound(proof, proof.serverSeed, { pair: kept, shoes, own });
// { ok, provable, errors, unproven, cards, outcome: { checked, summary } }

// A shoe, once it is over, with the cut the player asked for and the hands it saw dealt:
const shoe = verifyShoe(record.commit, record.reveal, { pair: kept, expectedCut: own.cuts[id], hands: own.hands[id] });
// { ok, provable, errors, unproven, dealing }

// A revealed pair with everything on record: every nonce once, every shoe of every table, every round in a proof.
verifySeedReveal(seed); // { ok, errors }
const pair = verifyPair(seed, proofs, shoes, { pair: kept, own });
// { ok, provable, errors, unproven, counts }

// Before the reveal: what a running shoe's commitment and a proof without its server seed bind already.
verifyShoeCommit(record.commit, { pair: kept }); // { ok, errors, unproven }
verifyProofBinding(proof, { pair: kept });       // { ok, errors, unproven }
```

The building blocks are exported too: `roundRng(serverSeed, gameId, clientSeed, nonce)` (an `Rng` whose `int(n)`
records its draws), `chainLink`, `shoeRoot`, `shoeOrder`, `shoeSalt`, `shoeHash`, `autoCut`, `rotate`, `burnOf`,
`shoeRulesFor`, `checkOutcome`, `crashPoint`, `sha256` and `hmacSha256`. `bin/report.ts` is what the command line
verifier and the page run on top of them.

## The verifier page

`web/index.html` is a single file with the library inlined: open it in a browser (from disk is fine), choose, drop
or paste the same JSON, and it shows the same report. Its content security policy lets it load nothing and send
nothing; its one script is allowed by its hash. `node web/build.mjs` builds it from `src/`, `bin/report.ts`,
`web/template.html` and `web/ui.js`.

## Tests and vectors

```sh
npm test
```

runs the tests on `node:test` (they also run unchanged under vitest). `vectors/v1.json` is written by
`node vectors/generate-node.mjs > vectors/v1.json`, an implementation of SPEC.md on node:crypto that shares no code
with `src/`; the tests check the library against it, against node:crypto and Web Crypto, and against RFC 4231.

## Layout

| Path | What |
|---|---|
| `SPEC.md` | the algorithm, the records and every check |
| `src/` | the library |
| `bin/` | `fairshoe-verify` and `report.ts` |
| `web/` | the verifier page and its build |
| `examples/` | bundles to try the verifier on |
| `vectors/` | test vectors and their independent generator |
| `test/` | the tests |

## License

MIT, see [LICENSE](LICENSE).
