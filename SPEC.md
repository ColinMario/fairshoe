# fairshoe/v1

Specification of fairshoe, provably fair random numbers and card shoes, algorithm version 1 (library
`fairshoe@1.2.0`, 27 October 2026). It is written so that anybody can build their own verifier from it (GLI-19 v4.0
draft, 5.5.3 a to e). The library in `src/` is the reference implementation; `vectors/` holds test vectors produced by
an independent implementation.

It was written for a play-money casino, the **reference server** below: where this document names one, it says how
that server meets a rule (its messages, its limits); another server may meet it differently. Provable fairness is a
trust feature, not a licence. It holds only where a server holds the seeds: when the server and the player are the
same device (a browser's local mode), nothing can be proven.

## 1. What is proven, what is not

Proven, for every round of a solo game (a casino game or a solo blackjack table) **whose client seed the player
set** (`clientSeedBy: "player"`, section 2), whose pair the player kept as it was shown before sending that seed,
checked against the player's own records (section 8):

- Every random value of the round is `int(n)` on a stream that is a fixed function of the server seed, the client
  seed, the game id and a nonce (section 4), and the server seed was fixed (its SHA-256 published) before the player
  chose the client seed and before any bet of the pair.
- Every card of a shoe comes from an order fixed by a hash chain whose terminal hash was published before the client
  seed, and the order was committed (salted hash) before anybody could cut the shoe (sections 5 and 6), under the
  game's published shoe rules (section 6).
- Every hand dealt from a shoe is one the player saw dealt (free hands included) and takes the cards the game's rules
  give (section 9): the server, which knows the order, cannot deal hands nobody asked for to choose the cards of the
  player's next hand. A solo blackjack round, whose hands have no fixed length, takes the first cards of its own shoe,
  each in the order the player saw it dealt and to the place the dealing rule gives it (section 6: over the boxes the
  player bet on, splits included; the player's record of the cards, where each went and its boxes, section 8), and
  each hand of its outcome holds exactly the cards dealt to it: the server cannot deal them in another order, to
  another hand (the player's card to the dealer, a box nobody bet on) or skip any. Which decision the player took on a
  hand is not part of the record. A round of a game with several tables was dealt at the table the player bet at. A
  round dealt from a shoe of an earlier pair (a shoe that ran on across a rotation) lies within that pair's last shoe
  numbers as the player received them at the rotation; a game that deals each round from a shoe of its own never does
  that.
- Every step that drew spent a nonce, also when the step was refused. In the pair's full record (section 7,
  PairRecords) a gap shows (a nonce or a shoe number missing between others); a record the server leaves out at the
  end shows against the reveal's last shoe numbers and against the player's own records (the proofs and shoe
  commitments received, the nonce seen before the rotation, section 8). Every round a shoe of the pair lists is in a
  proof.
- For the games of section 9 the outcome follows from the draws and cards under the game's full draw plan and card
  rules (the winner and the totals too); a finished round of such a game that does not state its outcome fails. For
  the others the draws and cards are proven, the outcome as the game reads them is not (yet).

Not proven:

- Rounds whose client seed the server picked (`clientSeedBy: "server"`: the player sent none before the pair's first
  draw or shoe). The server could have tried client seeds until it liked the outcomes. The verifiers report such
  records as not provable.
- What the player alone can know: which hash and root were shown before the client seed was sent, which client seed
  was sent, where the player cut, which hands it saw dealt, at which table it bet, which reveal it received at a
  rotation, which records the player received. A verifier takes them from the player's own records (section 8); the
  server's timestamps and its `by` fields are claims. Without them a verifier reports a record as `ok` but not
  `provable` and lists what is missing (`unproven`).
- A client seed the server could know before it made the pair: a predictable one, or one the player used before
  (for any pair). Such a seed proves nothing: the server could try server seeds and chains until it liked the
  outcomes. The verifiers refuse a seed sent for another kept pair; a predictable one they cannot see.
- Why a step was discarded or a shoe aborted: the verifiers count them, they cannot tell a refused step from one the
  server threw away because it did not like the draw (each costs it a visible nonce or shoe).
- That the server runs the published code. It does not need to: any deviation makes verification fail.
- That the server does not know the next outcome. It does; it cannot change it, and the player can change it with a
  new client seed before the next round (rotation).
- Coverage: a deterministic generator with a 256-bit key reaches at most 2^256 of the 416! orders of an eight-deck
  shoe (about 2^3025, or 2^2229 distinguishable ones). Every seed-based scheme shares this.
- A cut chosen by somebody who knows the order. The cut protects the one who cuts; the commitment protects everybody.
- Shared lounge tables use the additive table-chain/future-beacon construction in section 12. The existence and
  free choice of other human participants remain outside the proof.

## 2. Seeds and pairs

- **Server seed**: 32 random bytes from a cryptographic source, written as 64 lower-case hex digits.
  **Server seed hash** = SHA-256 over the 32 bytes (not over the hex text), hex.
- **Client seed**: 1 to 64 characters of `[A-Za-z0-9_-]`. The server never changes a client seed. The characters
  exclude `:` and `,`, so both are safe separators in messages and lists. It must be **fresh**: at least 128 bits from
  a cryptographic source (reference client: 16 random bytes, base64url, 22 characters), chosen after the pair was
  shown, and never sent again for another pair. A seed the server knew before it made a pair proves nothing
  (section 1). The reference server refuses a seed the player already sent for the game (`bad_request`); a rotation
  that carries one sending over to the next pair (below) is no second use: both pairs keep its `clientSeedAt`.
- **Pair**: server seed, client seed, next nonce (from 0), and for games with a shoe one hash chain per table plus
  their root (section 5). The reference server keeps the pairs per player and game: `gameId` is the casino game id
  (`roulette`, `baccarat`, ...) or the solo blackjack table id (`solo-classic`, `blitz-solo`, `freebet-solo`,
  `solo-vip`).
- **Order of commitments**: a pair is created with its server seed hash and its root and is shown to the player
  (`committedAt`; the reference server sends it on `fair` and `table_joined`, and on `game_joined`, which comes after
  a session's start may have used the pair) before it has a client seed. The player keeps it (section 8) and then
  sends a client seed (`clientSeedAt` > `committedAt`, `clientSeedBy: "player"`; a seed that arrives in the
  millisecond of the commitment is stamped `committedAt` + 1, both being the server's times, and no later record time
  is earlier). If the first draw or shoe of the pair comes first, the server picks one (`clientSeedBy: "server"`):
  such a pair is not provable. A client seed can only be set while the pair is unused (no nonce, no shoe).
- **Next pair**: besides the active pair the server shows the next pair's hash and root. **Rotation** reveals the
  active server seed and activates the next pair; a new next pair is made. The new active pair takes the client seed
  sent with the rotation; without one it keeps the player's client seed of the revealed pair when that seed was set
  after the next pair was committed (so it still came after the commitment; its `clientSeedAt` stays the time the
  player set it), else it has none yet. A rotation is allowed only while no round of the game waits or runs. A pair
  that was never used is not rotated (it would reveal nothing): a client seed sent with the request is set on it.
- **Automatic rotation**: when a shoe chain of the active pair is used up, the server rotates at the end of the next
  step that is outside a round (between two rounds), and says so (reference server: the note `seed_reveal`).

## 3. Messages

Every HMAC below is HMAC-SHA256 (RFC 2104, FIPS 180-4) over the UTF-8 bytes of the message. `{b}` is the block
number 0, 1, 2, ... All numbers are written in decimal without leading zeros.

| Purpose | Key | Message |
|---|---|---|
| Round stream | server seed (32 bytes) | `fairshoe/v1/stream:{gameId}:{clientSeed}:{nonce}:{b}` |
| Shoe stream (the shuffle) | chain link `{shoeNo}` (32 bytes) | `fairshoe/v1/shoe:{gameId}:{table}:{clientSeed}:{shoeNo}:{b}` |
| Shoe salt (one HMAC) | chain link `{shoeNo}` | `fairshoe/v1/salt:{gameId}:{table}:{clientSeed}:{shoeNo}` |
| Automatic cut | UTF-8 of the client seed | `fairshoe/v1/cut-auto:{gameId}:{table}:{shoeNo}:{b}` |
| Lounge bots (section 12) | table chain link | `fairshoe/v1/bots:{tableId}:{openingSeedHash}:{index}:{b}` |

`{gameId}` matches `^[a-z0-9][a-z0-9_-]{0,63}$` (lower case only: the id is written into the message as it is).
`{table}` is the table number at the game, an integer from 1 (1 when the game has one table; baccarat has 12). Only
numbers in the original solo-shoe domain. Shared lounge tables use the separate domains in section 12.

## 4. Round stream, integers, steps

- **Words**: the stream of a nonce is block 0 ‖ block 1 ‖ ..., read as unsigned big-endian 32-bit words, 8 per block.
- **int(n)**, n an integer with 1 ≤ n ≤ 2^32: for n = 1 the result is 0 and nothing is read. Otherwise
  `limit = 2^32 − (2^32 mod n)`; read words until one is below `limit`; the result is that word mod n. Every value
  of [0, n) is exactly equally likely. No floating point is used anywhere.
- **Steps**: a game runs in steps (`kind`: `init` start of a session, `act` a player's action, `wake` a timer,
  `abandon` the end of an abandoned session; `tx` for blackjack, every state change of the table). The first draw of
  a step takes the next nonce of the active pair; the step then reads that nonce's stream from its start, so each step
  that draws spends exactly one nonce. A step that drew and was then refused or failed keeps its nonce and is recorded
  as `discarded`.
- **Tape**: a step's record lists every draw as `{ n, v }` in order (n = 1 included) and the number of words read.
- **Rounds**: the proof of a round holds its steps and, when it finished, the steps of the same game since the
  previous round that belonged to no round (a card dealt while idle, a new lineup). A round that never finished (its
  stake was returned) gets a proof with outcome `{ "void": true }`. Before a rotation the remaining steps outside a
  round get a proof of their own (`roundId` null, `outcome` null); the reference server sends it with the reveal
  (`fair_revealed` `proofs`, or the note `seed_reveal`). Steps outside a round do not pile up either: once more than
  100 of them wait, all but the newest 10 get such a proof at once (reference server: the note `round_proof`); the
  newest ride along.
- **A step that never closes** (the process died between taking the nonce and closing the step) is on record all the
  same: the nonce is written together with a row for the step (`kind: "open"`, `discarded`, no draws), which the
  step's records replace when it closes. A verifier counts it as discarded, like any other (its reason is not
  proven). A gap among older records (written by a server without this rule) is closed at the next start with a
  discarded step without draws (`kind: "lost"`), and a chain link without its shoe gets that shoe back, aborted and
  revealed once nothing earlier on its chain runs; the link is never used for another shoe.
- **Secrecy**: proofs are published when their round has ended, never before (a draw may hold a secret such as a
  crash point); the server keeps a step's draws sealed until its proof is made; the server seed follows with the
  rotation.

## 5. Hash chains and the shoe root

- One chain per player, game and table with a shoe: a secret s of 32 random bytes and a length N (reference server:
  2000). Link i = SHA-256^(N − i)(s) for i = 0 ... N; link 0 is the **terminal hash**. SHA-256(link i) = link i − 1.
- Shoe number i (i ≥ 1) of the table is shuffled under link i. Revealing link i when shoe i is over opens that shoe
  and the earlier ones (already open), never a later shoe of this or another table (each table has its own chain).
- No record may hold the link of a shoe that can still be dealt. Shoe i's commitment holds link i − 1 (`prevLink`), so
  it goes out only once shoe i − 1 is over. A shoe opened by a step that did not happen while an earlier shoe of its
  chain still runs is never kept: its link is given back, and the table's next shoe takes it (the same order; nothing
  of it was shown). A shoe of a step the runtime cannot take back (reference server: a state change of the blackjack
  table) whose records failed is held: aborted without a reveal until its round or its table is over.
- **Root line**: `{gameId}:{table}:{terminal hex}`. **Root** = SHA-256 over the UTF-8 of the root lines sorted by their
  bytes (all lines are ASCII, so `baccarat:10:...` sorts before `baccarat:1:...`), joined with `\n` (no trailing
  newline), hex. The root is published with the pair's hash, before its client seed. It has exactly one line per
  table of the pair's game (section 6, `tables`), `{gameId}:1:...` to `{gameId}:{tables}:...`, and no other: a line of
  another game or an extra table would let the server pick per round between chains it fixed in advance.
- Shoes do not depend on the server seed: a rotation neither reveals nor ends a running shoe. A shoe belongs to the
  pair whose root binds its chain (`origin.seedId`); its client seed is that pair's. The cards of a round can come from
  a shoe of an earlier pair while its draws come from the active one.
- After a rotation the running shoe of a table, and its next shoe if that was committed already, stay on the old
  chain; every later shoe comes from the new pair's chain, starting at shoe number 1. So no shoe of a revealed pair's
  chains is committed after its reveal (`at` ≤ `revealedAt`), and the reveal's `lastShoes` are final. New chains come
  only with a new pair; a used-up chain leads to the automatic rotation of section 2.

## 6. Shoes

- **Cards**: rank then suit, `A 2 3 4 5 6 7 8 9 10 J Q K` and `S H D C` (`10H`, `AS`, `QD`). **Deck order**: suits
  S, H, D, C, each A to K. A shoe of d decks starts as d decks in deck order one after the other.
  **Letters** (compact order in records): letter i of `A`...`Z` `a`...`z` is card i of the deck order.
- **Shuffle** O: Fisher–Yates (Durstenfeld) over the starting order with the shoe stream: for i = size − 1 down to 1,
  j = int(i + 1), swap positions i and j. Nothing else is ever drawn from the shoe stream.
- **Salt** = HMAC of the salt message (32 bytes). **Shoe hash** = SHA-256(salt as 32 raw bytes ‖ UTF-8 of the card
  codes of O joined with `,`, no spaces, no trailing comma), hex. Hashing the salt's hex text gives a different hash
  and must fail verification.
- **Commitment** (`shoe_commit`): published before anybody can cut the shoe. Reference server: the shoes a session
  opens when it starts come with `game_joined`; a shoe opened by SHUFFLE comes with that step, the cut is a later
  step; the next shoe of a table is committed ahead when the shoe before it ends at its cut card (so a cut sent on the
  ended shoe finds its commitment out already). A solo blackjack table commits the shoe of its next round when bets
  open (the player joins the table, or the pause after a round ends; with `table_joined` and that step's `update`),
  once the pair has a client seed: a pair still without one waits for the player's (`fair_client_seed`, whose step
  commits the shoe), since committing first would make the server pick the seed. The player may cut it while bets are
  open (message `cut`, changeable until the deal) or leave it to the deal, which cuts it automatically; a rotation or
  a new client seed while bets are open replaces it with one of the new pair (the old one is revealed as aborted). It
  never contains the shoe's own link, only the previous one (`prevLink`), the terminal and the root.
- **Cut**: k cards from the front go to the back: dealing order D[i] = O[(i + k) mod size]. A rotation by a k that
  does not depend on O leaves a uniform order uniform, so the cut changes the order, never the odds.
- **Automatic cut** kAuto = min + int(max − min + 1) on the cut-auto stream. It depends only on values fixed before the
  shuffle (client seed, game, table, shoe number), so it is independent of O and cannot be steered through the salt
  (and, the range being the published one, not through the range either).
- **Cut policy**: `player`: the player may cut anywhere in the range (`by: "player"`), or cut automatically; `auto`:
  only kAuto. A cut `by: "auto"` or `"timeout"` must equal kAuto.
- **Burn rules** (counted from D[0], before the first round):
  - `none`: nothing burnt;
  - `bj-one-down`: one card face down;
  - `bac-value`: the first card face up, then as many cards face down as its baccarat value (A 1, 2 to 9 their
    number, 10 J Q K 10); burnt cards = 1 + that count. (The record's `burn.cards` counts all of them; the game's
    `burn` event counts the face-down ones.)
- **Cut card**: `endAt` is the index in D of the first card behind the cut card. The round that deals index endAt is
  the shoe's last; no round follows it. `endAt: null`: no cut card (a shoe for one round).
- **End and reveal** (`shoe_reveal`): every end is revealed: `ended` (the cut card came out, or the one round of a
  one-round shoe is over), `shuffled` (shuffled before its end, on request), `aborted` (opened by a step that did not
  happen, replaced by the next shoe of the table without having ended, or left behind by stored progress that no
  longer matched it). The reveal holds the link, the salt, O as letters, the cut, the burn and every round dealt from
  the shoe as `{ roundId, from, to }` (cards [from, to) of D; `roundId` null for a free hand).
- **Hands**: the rounds list every hand dealt from the shoe in the order dealt, free hands included, and nothing
  else; each takes exactly the cards its game's hand rule gives (section 9: a punto banco hand of the baccarat family,
  two cards in Dragon Tiger and Card Duel). The player is told every hand as it is dealt (reference server: the note
  `shoe_deal` `{ shoe, table, roundId, from, to }`) and keeps them (section 8). A shoe for one round (`endAt` null)
  lists that round alone, with its round id, from the first card after the burn. Blackjack hands have no fixed
  length: the player also keeps the cards it saw dealt in its round, in dealing order (reference server: the `card`
  events, the dealer's hole card at its place once `hole_reveal` turned it), where each went (the event's `to`: the
  dealer, or hand h of box s), the splits it saw (the `split` events, before which card) and the boxes holding its main
  bet when it dealt; the cards must be D[from, to) card by card, their places must follow the blackjack dealing order
  below over those boxes.
- **Shoe rules**, part of v1 (`src/rules.ts`); a commitment with other rules fails verification. The rules are always
  those of the game the player plays (the kept pair's, the proof's), never the ones a commitment names: a shoe whose
  commitment names another game fails.

| Games | tables | decks | cut range | endAt | burn | cut policy |
|---|---|---|---|---|---|---|
| `baccarat` | 12 | 8 | 52 to 364 | 364 | `bac-value` | `player` |
| `blitz-baccarat`, `gold-baccarat`, `jade-baccarat`, `blitz-baccarat-max`, `dragon-tiger`, `card-duel` | 1 | 8 | 52 to 364 | 364 | `bac-value` | `player` |
| `solo-classic`, `blitz-solo`, `freebet-solo`, `solo-vip` (a fresh shoe for every round) | 1 | 8 | 52 to 364 | null | `none` | `player` (a commitment stating `auto`, the row of 1.1.0, is accepted and held to kAuto) |

- **Dealing order of a hand**: baccarat P1, B1, P2, B2, then the Player's and the Banker's third card; Dragon Tiger
  and Card Duel the first side (dragon, home), then the second (tiger, away); blackjack box 1 card 1, box 2 card 1,
  ..., dealer up card, box 1 card 2, ..., dealer hole card (the boxes in seat order, the boxes with a main bet only;
  the hole card is the only card dealt face down), then each decision in seat order, then the dealer's draws. The
  decisions: the boxes are played one after the other in seat order, the hands of a box in order; a card goes to the
  hand whose turn it is and never back to a hand whose turn is over. A split of a hand of two cards moves its second
  card to a new hand right behind it (the box's later hands move up one); the split hand takes the next card, the new
  hand its second card when its turn comes. The dealer draws after every hand of every box is over.

## 7. Records

Times are milliseconds since 1970 (UTC). Ids are opaque strings. `clientSeedBy` is `"player"` or `"server"`
(section 2).

```text
RoundProof { v: 1, alg: "fairshoe/v1", lib, id, gameId, roundId | null, seedId, serverSeedHash, clientSeed,
             clientSeedBy, serverSeed | null,
             steps: [{ nonce, kind, status: "ok" | "discarded", draws: [{ n, v }], words }],
             shoes: [{ shoe, table, from, to }], outcome, engineVersion, at }
ShoeCommit { alg, shoe, gameId, table, shoeNo, decks,
             origin: { kind: "chain", seedId, chainId, index, prevLink, terminal, root },
             clientSeed, clientSeedBy, shoeHash, cutRange: [min, max], cutPolicy: "player" | "auto", autoCut,
             endAt | null, burnRule, at }
ShoeReveal { shoe, status: "ended" | "shuffled" | "aborted", link, salt, order, cut: { at, by } | null,
             burn: { cards, shown | null } | null, rounds: [{ roundId | null, from, to }], at }
SeedReveal { seedId, gameId, serverSeed, serverSeedHash, clientSeed | null, clientSeedBy | null, lastNonce,
             lastShoes: [{ table, shoeNo }], root: { hash, lines } | null, committedAt, clientSeedAt | null, revealedAt }
PairRecords { seedId, gameId, proofs: [proof id], shoes: [shoe id] }
HandSeen    { roundId | null, from, to, cards?, places?, splits?, boxes? }
            (as the note shoe_deal told it, with its shoe and table; cards: the cards seen dealt in it, in order, null
             for one face down; solo blackjack: places, where each card went, "dealer" or { seat, hand }; splits:
             [{ at, seat, hand }], hand `hand` of box `seat` split before card `at`; boxes: the seats with the
             player's main bet when it dealt, in seat order)
PlayerRecords { proofs?: [proof id], shoes?: [shoe id], nonce?, cuts?: { shoe id: { at } | "auto" },
                hands?: { shoe id: [HandSeen] }, tables?: { round id: table } }   (kept by the player, section 8)
```

- `lastNonce`: nonces 0 ... lastNonce were spent; -1: none. `lastShoes`: the last shoe number taken from each chain
  of the pair (0: none), one entry per root line; empty without a root.
- A shoe slice names the table the round was played at; the shoe's commitment names the same.
- `outcome` is the game's own summary of the round (`{ result, detail }` for casino games, the history entry for
  blackjack); `{ "void": true }` for a void round, null for the proof of steps outside a round. Section 9 says for
  which games it is checked.
- `PairRecords` lists every proof of the pair (void ones and those of steps outside a round included) and every shoe
  of its chains (aborted ones included). Reference server: message `fair_records`, `GET /api/fair/seed/:id/records`. A
  revealed pair's records never change.

## 8. Verification

What the player keeps, because the records cannot prove it:

- the pair as shown **before** sending the client seed: its `seedId`, game, hash and root (`fair.active`, and
  `fair.next` for the pair a rotation activates with that seed). Nothing that comes after the seed was sent (a later
  `fair`, a `game_joined` after a session's start, a reveal) may stand in for it: those are the server's claims;
- the client seed sent (fresh, section 2), each cut asked for (a position, or the automatic cut: at solo blackjack a
  deal without a cut of the player's), every hand it saw dealt from each shoe (`shoe_deal`, free hands included; a
  solo blackjack round with the cards it saw dealt in it, where each went, the splits and the boxes it bet on) and the table it bet at in each round of a game with several
  tables. A cut counts as the player's only when the player had the shoe's commitment before it sent the cut (else the
  server could still choose which shoe gets the cut);
- what it received of the pair: the ids of its proofs and of the shoes whose commitments it got, and the pair's next
  nonce as last seen before the rotation;
- the reveal received at the rotation (`fair_revealed`, `seed_reveal`): its `lastShoes` and `revealedAt` are final.
  A later copy of the reveal must say the same; a round of a later pair may come from this pair's shoes only up to
  those shoe numbers.

Every verifier takes the kept pair as an input (the library's `PairSeen`, with the reveal received once there is one)
and the player's own records (`PlayerRecords`). `provable` is true only when `ok` is, the client seed was the
player's, the record is bound to a kept pair and the player's records bind what only the player knows: the cut of a
shoe the player could cut, the hands of a shoe with a cut card and the round of a solo blackjack shoe with its cards,
their places and the boxes,
the table of a round at a game of several tables, the reveal of an earlier pair whose shoe dealt the round, and for a
pair the proofs, shoes and nonce received. While `ok`
holds without them, a verifier lists what is missing (`unproven`).

A shoe (`verifyShoe`, on the commitment and the reveal together, with the kept pair of `origin.seedId`; without it it
fails):
0. The commitment is of the pair's game; its rules (decks, cut range, endAt, burn rule, cut policy) are that game's
   published rules (section 6). `clientSeedBy` is `"player"` (else: not provable).
1. SHA-256(link) = `prevLink`, SHA-256^shoeNo(link) = `terminal`; the pair's root lines are exactly one per table of
   the game (section 5), they hash to the pair's root, which is `origin.root`, and the root line of the terminal is
   among them; `origin.seedId` is the pair's; its client seed is the commitment's; committedAt < clientSeedAt ≤ the
   commitment's `at`; once the pair is revealed, `at` ≤ `revealedAt`.
2. The shoe stream under the link gives O; it equals the revealed order.
3. The salt is the HMAC of the salt message; SHA-256(salt ‖ codes of O) = `shoeHash`.
4. kAuto recomputed equals `autoCut`; the cut lies in `cutRange`; an automatic cut equals kAuto; under the game's `auto`
   policy the cut is automatic; the record's cut is the one the player asked for.
   A solo cut selected before DEAL may remain unapplied if the unused shoe is aborted by a rotation or restart.
   With no burn or rounds, that unfulfilled selection is `unproven`, not a contradictory applied cut. Any consumed
   cards, changed applied cut, or other game/status still requires the recorded cut.
5. The burn follows the rule on D; the rounds follow each other without gaps from the first card after the burn.
6. With a cut card: the round that dealt index endAt is the last; an `ended` shoe dealt it, a `shuffled` or `aborted`
   one did not. Without one: one round at most, with a round id; an `ended` shoe has it.
7. Every round takes the cards of its game's hand rule (section 9), free hands too.
8. The rounds are exactly the hands the player saw dealt from the shoe (round id, from, to), no more, no fewer; the
   cards it saw dealt in a hand, when given, are D[from, to): as many, each card shown the one at its place (a card
   shown face down only takes its place). Solo blackjack: the places follow the dealing order of section 6 over the
   boxes the player bet on (the first deal exactly; then the hand in turn, the split hand right after its split, the
   dealer last), and only the hole card was dealt face down. A solo blackjack shoe is provable only with the cards,
   the places and the boxes.

A round (`verifyRound`, with the revealed server seed, its kept pair, and the records of its shoes and the kept pairs
of their chains when it was dealt from a shoe):
1. SHA-256 of the revealed server seed equals `serverSeedHash`, which is the kept pair's; the proof's pair, game and
   client seed are the kept pair's; `clientSeedBy` is `"player"` (else: not provable). Without the kept pair the
   arithmetic can be checked, the proof is not provable.
2. For each step, in increasing nonce order (discarded steps too): replay the round stream of its nonce; each recorded
   draw `{ n, v }` must equal `int(n)` in order, and the words read must equal `words`.
3. Shoe slices: each shoe is of the proof's game and at the slice's table, verifies (above) against the kept pair of
   its chain and the player's cut and hands of it, and lists the slice among its rounds under the proof's round id (or
   as a free hand, `roundId` null); D[from, to) are the round's cards. A shoe that still runs cannot be checked yet. A
   round of a card game (section 9) has its own slice; without one its cards are on no record. The round's own slices
   are at the table the player bet at and the one its outcome names (`detail.table`). A shoe of another pair is of an
   earlier one, within its kept `lastShoes` for the table, and never for a game whose shoes are for one round.
4. For the games of section 9 the outcome is recomputed from the draws and the cards of the round's own slice, under
   the game's draw plan and card rules. Solo blackjack: the cards the outcome names (every hand but those marked
   `behind`, which repeat a box's cards, and `dealerCards`) are the cards of the round's own slice, D[0, n) of its
   shoe, as many and the same ones; with the player's record of the round each hand of the outcome, in the order of
   play, is the box and the cards the player saw dealt to it (in the order dealt), and `dealerCards` are the cards
   dealt to the dealer. An outcome that names no cards binds none: not provable. The payouts are not mapped.
5. The client seed was not sent for another kept pair (unless one sending a rotation carried over: the same
   `clientSeedAt`).

A pair (`verifySeedReveal`): the seed matches its hash, the root its lines, `lastShoes` names the root's tables; when
it has a client seed, the player set it (`clientSeedBy: "player"`) after the pair was shown (`clientSeedAt` >
`committedAt`); without one, no nonce or shoe was spent. With everything on record (`verifyPair`, PairRecords, with the
kept pair and the player's own records):
- the reveal is the kept pair (seed id, game, hash, root, client seed), and its root lines are the game's tables;
- every proof verifies under it; nonces 0 ... `lastNonce` each appear in exactly one proof;
- the shoes of each table are numbered 1 ... the table's `lastShoes` number, each once (running shoes are counted,
  checked once over), each verified against the kept pair; at most two of a table (the running one and one committed
  ahead) were still in play at the reveal (no reveal yet, or one after `revealedAt`);
- every round a revealed shoe lists under the id of one of the proofs is a slice of that proof, and every round a
  shoe of the pair lists is in a proof (of the pair, or of a later pair given for the rounds dealt after the
  rotation): a round without a proof binds nothing;
- the reveal's `lastShoes` and `revealedAt` are those of the reveal received at the rotation, when kept;
- the client seed was not sent for another kept pair;
- every proof and shoe commitment the player received is on record, and `lastNonce` ≥ the nonce seen before the
  rotation − 1.
Discarded steps, void rounds, free hands and aborted shoes are counted.

Before the reveal a record cannot be recomputed, but it is bound already, and a contradiction is an error at once
(`ok` only says that nothing contradicts the kept pair; such a record is never provable, it is pending):
- a shoe still in play (`verifyShoeCommit`, the commitment with the kept pair of `origin.seedId`): its fields, the
  game and published rules of the pair's game (step 0 above), its origin (step 1 without the link: the pair, the
  root, the terminal among the root lines, the client seed set after the pair was shown and before the commitment,
  the commitment before the pair's reveal), `clientSeedBy` `"player"`, and kAuto recomputed from its inputs;
- a round proof without its server seed (`verifyProofBinding`, with the kept pair of `proof.seedId`): its algorithm
  and fields, the pair, game, server seed hash and client seed of the kept pair (step 1 without the seed),
  `clientSeedBy` `"player"`, the client seed not sent for another kept pair, nonces increasing, known step statuses,
  well-formed shoe slices.

## 9. Game mappings

How the draws and cards of a round become its outcome, for the games below (`src/games.ts`). A mapping fixes the
round's whole **draw plan**: the applied steps of the proof (discarded ones aside), the steps outside a round riding
along included, have exactly one step that draws, and it draws exactly the ranges listed, in order. Anything else (a
draw before or after them, a second drawing step) is an error: the server writes the draws down itself, and with extra
draws it could pick the value the game reads. The proof's `outcome.detail` (an object) must agree; a finished round
that states none is an error, never an unchecked round. A void round of a game with a draw plan draws its plan or
nothing; a proof of steps outside a round (`roundId` null) of such a game draws nothing.

| Game | Draw plan | Mapping | Checked against |
|---|---|---|---|
| `roulette` | one step: int(37) | pocket = the draw (0 to 36) | `detail.pocket` |
| `american-roulette` | one step: int(38) | pocket = the draw; 37 is `"00"` | `detail.pocket` |
| `high-flyer` | one step: int(2^32) | r = the draw; crash = min(2,000,000, max(100, floor(97 · 2^32 / (2^32 − r)))) in hundredths (1.00x to 20,000x) | `detail.crash` (the multiplier: crash / 100) |
| `dice-baccarat` | one step: int(6), int(6), int(6), int(6) | each + 1: Player die 1, die 2, Banker die 1, die 2 | `detail.dice` |
| `baccarat` | no draws matter: the cards come from the shoe | the round's own slice (exactly one), replayed by the tableau below | `detail.player`, `detail.banker`, `detail.playerTotal`, `detail.bankerTotal`, `detail.winner` (`natural` when stated), `detail.table` |
| `dragon-tiger`, `card-duel` | as baccarat | the round's own slice, two cards: first side, second side; the higher rank wins, equal ranks tie; suited = the same card | `detail.cards`, `detail.winner`, `detail.suited` |

**Card rules (part of v1).** Baccarat value: A 1, 2 to 9 their number, 10 J Q K 0; a total is the sum mod 10.
Punto banco from the hand's first card: P1, B1, P2, B2. A total of 8 or 9 on either side is a natural: no more cards.
Else the Player draws a third card on 0 to 5 and stands on 6 or 7; then the Banker: when the Player stood, draws on 0
to 5; when the Player drew a card of value t, draws on 0 to 2, on 3 unless t = 8, on 4 when t is 2 to 7, on 5 when t
is 4 to 7, on 6 when t is 6 or 7, never on 7. The Player's third card comes before the Banker's. The higher total
wins (`player`, `banker`, else `tie`); a hand takes 4 to 6 cards. Dragon Tiger: ranks A 1 (low), 2 to 10, J 11,
Q 12, K 13, winner `dragon`, `tiger` or `tie`. Card Duel: A 14 (high), winner `home`, `away` or `draw`. Both take two
cards per hand. Every hand a shoe of these games deals takes exactly the cards these rules give (section 6), free
hands too.

The multiplier variants `gold-baccarat`, `jade-baccarat`, `blitz-baccarat`, `blitz-baccarat-max` draw their strikes
from the round stream: their hands are replayed by the tableau like baccarat's (a disagreement is an error), but the
outcome of historical records without versioned payout detail is not checked. New payout mappings for classic and
multiplier baccarat, the four solo blackjack variants, Hi-Lo and Trading are specified in section 11.2. They require
player-owned inputs and authorization for every random step; an internally consistent server transcript is insufficient.
`blitz-roulette` and `blitz-roulette-max` still have no payout mapping. Craps, sic bo, money wheel, bingo, race day and
video poker retain their stream/card checks without a full payout replay.

## 10. Test vectors

- `vectors/v1.json`: written by `vectors/generate-node.mjs`, an implementation of this document on node:crypto that
  shares no code with `src/`. Server seed `000102...1f`, client seed `player-seed-01`, chain secret `202122...3f`:
  seed hash, the first block of a round stream, roulette, American roulette, craps, high flyer (with the crash point)
  and dice baccarat draws, int(n) for n = 1, 2, 3, 2^31 + 1, 2^32 and a rejected word, a three-link chain and a
  2000-link terminal, a root, a baccarat shoe (order, salt, hash, hash with a hex salt, kAuto, dealing order with its
  k, burn, cards at endAt − 1 and endAt), a blackjack shoe (cards at 207 and 208 after its cut k = kAuto, endAt null),
  a shuffle with a rejected word (416 words for 415 swaps), the span of kAuto (min and max over shoes 1 to 2000 of
  baccarat table 1 with that client seed), the cut range edges (51 and 365 refused, 52 and 364 allowed), burns of a
  ten and of an ace, two chains whose shoes end in reverse order, and complete records (pair as revealed and as kept,
  commitments, reveals, proofs) of a Dragon Tiger shoe, a solo blackjack round (its own shoe cut by the player, with
  the player's own records: the cut, the round with the cards seen, their places and the box), a solo blackjack round
  on two boxes (seats 0 and 2) with a split and a roulette round. Negative vectors
  (`negative`): a roulette spin after 42 draws of int(2) that turn the honest pocket 27 into 0, a roulette step with
  two spins, and a High Flyer flight after a filler draw: every draw is on the round stream, the draw plan refuses
  them. Records with the player's own records (`ownRecords`): a baccarat shoe of a twelve-table pair cut by the player
  at 150, a free hand and two bets at table 3 by the tableau, with the cut, the hands seen and the tables. Negative
  vectors against the card rules and the player's records (`negativeOwn`): a free hand slipped into the Dragon Tiger
  shoe, a cut recorded at 202 for one asked at 200, a baccarat hand one card off the tableau, a flipped winner, a
  round dealt at table 3 for a bet at table 5, solo blackjack shoes with a hand outside the round and with two rounds,
  a solo round two cards longer than the cards it played, one whose outcome names a card its slice does not have, one
  whose cards came in another order than the shoe's (the hole card and the box's second card swapped), one recorded
  with a cut moved by two, the same cards in the same order to other places (an outcome giving the box's first card
  to the dealer, and one swapping box and dealer; cards seen going to the dealer first; a box nobody bet on taking
  cards; every card shown face down), the padded roulette spin without its outcome detail, and a pair under a client
  seed already sent for another.
- The tests check the library against this file, against node:crypto and Web Crypto, and against RFC 4231.

## 11. Versions and what comes next

The algorithm id is part of every record; any change to section 3 or 4, and any change to section 6 that alters a drawn
value or refuses a record an earlier library accepted, makes a new id. Library 1.1.0 added `clientSeedBy`,
`origin.seedId`, `cutPolicy`, the shoe rules with the tables per game, PairRecords, `lastShoes`, the table of a shoe
slice, the game mappings with their draw plans and the stricter verifiers to 1.0.0: every verifier checks against the
pair the player kept (seed id, game, hash, root, client seed), `verifyShoe` and `verifyPair` require it, `verifyPair`
takes the player's own records. 1.1.0 also binds what only the player knows: the hands seen (`HandSeen`,
`PlayerRecords.hands`, the note `shoe_deal`), the cuts and tables (`PlayerRecords.cuts`, `tables`), the reveal received
at a rotation (`PairSeen.lastShoes`), the fresh client seed; it adds the card rules of section 9 (tableau, winners, hand
lengths), the one-round shoe rule, the required outcome detail and the draw plan of void rounds and steps outside a
round, `provable` and `unproven` on every result, `later` for `verifyPair`, the checks before the reveal
(`verifyShoeCommit`, `verifyProofBinding`), the command line verifier and the verifier page. The algorithm id is
`fairshoe/v1`: every message of section 3 begins with it, so every value drawn from a message (streams, orders, salts,
shoe hashes, kAuto) is that of `fairshoe/v1`; a record under another id fails here as an unknown algorithm.
`vectors/v1.json` holds the values of `fairshoe/v1`.

Library 1.2.0 (27 October 2026; 1.1.0 was published the same night in the public repository) changes the solo row of
section 6 and widens what a solo round binds; every value of sections 3 and 4 stays, and the records of 1.1.0 (its
vectors, the reference server's) still verify (a solo round of 1.1.0 is ok, not provable: it lacks the record of the
places), so the id stays `fairshoe/v1`. The four solo tables still deal every round from a shoe of its own, now cut by
the player (cut policy `player`: a position while bets are open, or the automatic cut kAuto when the deal comes without
one); a shoe committed under the row of 1.1.0 (cut policy `auto`) is still accepted and held to kAuto. A solo round is
bound to its shoe card by card by the player's record of the cards (HandSeen.cards) and to its hands by where they went,
the splits and the boxes (HandSeen.places, splits, boxes, the blackjack dealing order of section 6), and its outcome's
hands are compared with them; an outcome that names no cards (a record of 1.1.0 may) is not provable. A verifier of
1.1.0 refuses a solo shoe of the new row (cut policy `player`): the public repository and any copy of it need 1.2.0. A
continuous solo shoe (one shoe for many rounds, the player's cut, a `bj-one-down` burn, the cut card at 208) was drafted
and dropped: a card counter with the tables' bet spread beat it (about 100.9 %), and no strategy may reach 100 %.
The current additive extensions include shared lounge proofs and the versioned payout mappings below. Further
game mappings remain future work; their outcomes must not be labelled payout-checked.

### 11.1 Additive composition guard (library 1.2)

The random stream, shuffle, salted shoe hash and `fairshoe/v1` domain strings are unchanged. New card-family
commitments opt in with `guard: "rtp-995"`; multiplier commitments also name `guardWeights:
"baccarat-multiplier/1"`. Unknown tags fail validation. The player retains those header values before play in
`PlayerRecords.shoeRules`; stripping or changing a retained marker is a contradiction. Marker-free historical
commitments keep their original rules, including the old continuing Max shoe.

The guard's input is the count of each of the 52 identities not yet seen. Only the shown burn card and cards
shown in previous hands are removed; hidden burn cards remain in this conditional sample space. The exact
rational return includes all side wagers and multiplier identity repetitions, including the joint product on
Tie's four to six cards. A board is accepted only if its expected return is at most 995/1000 of its cost.
Current Max shoes end after one paid or free hand. Other shoes end as `guarded` before a main wager exceeds the
cap; their reveal carries `guard: { before, spot, num, den }`, with numerator and denominator as decimal strings.
The verifier checks every preceding boundary as well as this exact final reason. A hand after an earlier trigger
or an arbitrary early `guarded` end is an error.

Side-wager reductions follow the published spot order. Classic Bonus, Perfect Pair and Banker Six additionally
require main-wager coverage at 1/2, reduced to 1/4 from card 312. Fee rounding up and payout rounding down only
reduce the bound. The client records its submitted board and the matching granted board or explicit guard
refusal as `GuardDecision { before, requested, granted, unanswered? }` in `PlayerRecords.refused[shoe]`.
`granted: null` denotes a guard refusal. A missing reply is recorded with `unanswered: true`, not as a proven
refusal. The verifier rejects an unjustified trim/refusal; absent or incomplete evidence stays unproven.

`PlayerRecords.shuffles[shoe]` records the boundaries at which the player requested a shuffle. An early
`shuffled` shoe without such a request is unproven. These records narrow the availability limitation in section1;
they do not prove why an unrecorded step was discarded, why a shoe was aborted, or all game payouts in section9.

### 11.2 Player-owned payout replay and draw authorization

`PlayerRecords.gameplay[roundId]` supplies a complete acknowledged input witness, retained before receiving the
outcome. Versioned mappings are `hilo/rounded-v1`, `trading/carry99-v1`, `blackjack/payout-v1` and
`detail.payoutProof.version = "baccarat/payout-v1"`. Rules are immutable public versions, never arbitrary rule objects
from the server. `outcome.payoutsChecked` is separate from checked cards or a checked winner. Historical records may
retain valid card/stream checks while their payouts remain unchecked. Missing own inputs are `unproven`; contradictory
inputs or incorrect money are errors.

`PlayerRecords.authorizedDraws[seedId][nonce]` records the operation actually requested and acknowledged:
`hilo-init`, `hilo-exchange`, `hilo-guess`, `trading-trade`, `blackjack-board`, `baccarat-free`, or `baccarat-deal`.
Hi-Lo entries also retain the card actually displayed. The client initializes its own counter at zero only after
confirming its own client seed. It advances only for a successful authorized operation. `fair_get.active.nonce` is
a cross-check and must never advance this counter. An unknown reply leaves a gap. A later announcement cannot close
that gap or authorize skipped draws. Reservations are persisted before sending, including initialization and free
operations. A known rejection consumes no authorization.

Every G9 RNG step, including prefixes, free hands and steps moved into a separate idle proof, must have matching
own authorization. A discarded step anywhere makes the extended payout sequence unproven. A payout witness's
`startNonce` comes from the own counter. This closes both discarded and apparently applied prefix cherry-picking.
The exact ranges and ordering of each operation are independently checked by the replay; a valid HMAC alone does
not establish a legal draw plan.

Hi-Lo replays each acknowledged higher/lower choice, rounded-bank continuation, the first-step 99% factor, random
cent rounding, caps, target changes and ending. Its face-up starting card must come from an authorized init/exchange
or a verified previous paid round (`cardFrom`). Trading replays the draw, movement, Portfolio, fee and carry; initial
carry is 99, and later carry/Portfolio states refer to earlier proofs. Blackjack replays cards, destinations,
insurance, decisions, splits, double/free double, Cash Out, fees, board draws and pending multiplier coverage from
own bets and public rule versions. R1 saves only the first split hand's earned category. Baccarat replays the tableau,
strikes and exact weighted draw plan, accepted board, fees, commission, side bets and payout cap. Its own guard
receipt also binds `seedId` and `startNonce`; genuine earlier Free hands remain separately authorized.

Empty carry and a zero Portfolio are state claims too: they are compared with the predecessor, rather than
accepted from an empty current display. Blackjack references the last participating proof separately for each
seat; `initialSeats` names seats whose zero carry was retained from the own fresh-table timeline. Pruning a
witness cannot recreate initial-state knowledge. A definite rejected operation does not advance predecessor
heads; an unknown or successfully applied operation lacking its proof leaves a persistent continuity gap.

`RoundVerifyOptions.prior`, `PairVerifyOptions.prior` and bundle `prior` provide predecessor proofs. Only independently
verified, provable, payout-checked predecessor state can anchor carry, Portfolio or a Hi-Lo card. Dependencies are
checked recursively; cycles, conflicting copies and predecessors that do not precede the round fail. Equal observed
timestamps do not destroy a valid nonce order. Identical copies are deduplicated. The online collector follows own
references, fetches the corresponding seed reveals/shoes and retains missing dependencies as unproven.

Public vectors `vectors/g9.json` and `vectors/g9-blackjack.json` include real engine proofs. The draw-authorization
negative suite replaces a confirmed Trading loss with a later win using discarded, applied or empty prefix steps;
none can become provable. Independent blackjack replay is also checked against complete actual engine rounds.

## 12. Shared lounge rounds with a future public beacon

The additive `RoundProof.lounge` version 1 uses policy `lounge-bots/1` and a separate hash chain per lounge table
(maximum 2000 links). `LoungeRoundCommit` retains table/root/chain/index/previous link, opening time and seeds,
opening bot state, initial/reset flag and the full bot plan's hash. At index 1 the initial flag is required. Later
rounds preserve the preceding committed bot state, decrementing participation counters only for bots that played;
an explicit void permits a reset. A new root needs a new player seed chosen after that root was received.

All hashes below use SHA-256 and lowercase hex. Canonical JSON sorts object keys recursively, preserves array
order, omits undefined object fields and permits only safe integer numbers. Participant seed rows are sorted by
player id, with no duplicates. Their `by` marker distinguishes a player seed from the server fallback. The bot
stream is HMAC-SHA256 keyed by the revealed table link, over
`fairshoe/v1/bots:{tableId}:{hash(openingSeeds)}:{index}:{block}`. The public `planLoungeBots` policy fixes seating,
lifecycle, all stakes and insurance coins before the card beacon can be known. `loungeBotAction` fixes subsequent
basic-strategy decisions; presentation timing consumes no values of these monetary streams.

`LoungeRoundLock` freezes `commitId`, `roundId`, close time, published deadline, timer/ready reason, ready player
ids, final participant seeds, boxes/owners/behind shares, complete bot plan and `beaconRound`. Its hash is over all
these fields excluding the hash itself. A timer close cannot precede the published deadline; a ready close requires
all human wager owners' ready votes. Published betting durations are 15000 ms, or 8000 ms for Speed. Planned bot
wagers are placed even when humans close early. No wager may be changed after this lock.

The pinned Quicknet chain is `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`, genesis
1692803367 seconds, period 3 seconds. `beaconRound` is the first round whose scheduled time is strictly greater than
`closedAt + 3000 ms`. `verifyQuicknetBeacon` checks the BLS signature against the pinned public key using the
Quicknet short-signature scheme and its correct G1 DST, and randomness is SHA-256(signature bytes). Neither a
server-supplied randomness field nor a successful network response substitutes for signature verification. A retry
must fetch the same round. No latest-round selection or seed replacement is permitted.

The shuffle uses the existing rejection-sampled integer stream, Fisher–Yates and eight ordered decks, with the
link as HMAC key and message `fairshoe/v1/lounge-shoe:{lock.hash}:{beacon.randomness}:{block}`. The automatic
cut is 52 + int(313) from HMAC keyed by SHA-256(UTF8(lock.hash)), message
`fairshoe/v1/lounge-cut:{lock.commitId}:{block}`. Apply the existing cut rotation. There is no burn or cut-card
ending: one fresh shoe is used for this round only. The public beacon and fixed lock prevent selecting the card
order after seeing the complete wagers, subject to the beacon's security and availability.

`verifyLoungeRound` reconstructs this order, replays the immutable `lounge/g1` blackjack rules and compares cards,
actions, insurance, hand results and per-owner ledgers including Bet Behind. Its independent replay returns every
card destination. Bot actions and insurance must match the published policy. Automatic human turns must obey
Hit through 11 / Stand above 11, and timeout insurance may only decline. Timeout actions include their deadline
and execution time; own turn receipts constrain that deadline. An absent player's completion remains distinguishable
from a timeout. Rejected state-changing requests after lock are counted as `discarded`; they never consume another
seed or produce a replacement order.

Provability additionally requires `PlayerRecords.lounge[roundId]` (`LoungeOwnRecords`): the retained root before
the own seed, commit and lock before the scheduled beacon time, the observed betting deadline, complete acknowledged
own wagers/ready/actions/insurance, seen cards/destinations/actions/turns and chain predecessors for bot lifecycle.
Receipt times use the player's local UTC clock, not a server-provided offset. The player's clock must therefore be
accurate enough to distinguish arrival before the scheduled beacon. A single unknown legal dealer-hole position
is allowed; observed cards, lengths and every other position remain exact. Missing, late or partial evidence is
unproven; contradictions fail. `betsComplete:false` never turns an unknown wager board into an accusation. Complete
previous proofs establish bot continuity but do not prove the existence or free choices of other humans.

A successful proof is wrapped in the original envelope with `gameId = commit.tableId`, `roundId = lock.roundId`,
`seedId = commit.chainId`, `id = pf_{commit.id}`, hash equal to the table terminal, client seed equal to the frozen
seed-set hash, and no solo steps/shoes. The pure verifier dispatches this envelope directly without a solo server
seed. A void proof reveals the spent link and locked inputs, records the reason, and remains payout-unproven;
missing outcome availability cannot be transformed into a fair result. Demo proofs also remain unproven.
