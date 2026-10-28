// Run in the package folder: node vectors/generate-node.mjs > vectors/v1.json (seconds; the searches below take the time).
// Independent reference of fairshoe/v1 (SPEC.md) with node:crypto, used to produce vectors/v1.json.
// It shares no code with src/: every value below is computed from the specification alone.
import { createHmac, createHash } from 'node:crypto';
const SEED = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const CHAIN_SECRET = '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f';
const CS = 'player-seed-01';
const LIB = 'fairshoe@1.2.0';
const sha = (b) => createHash('sha256').update(b).digest();
const hmac = (k, m) => createHmac('sha256', k).update(Buffer.from(m, 'utf8')).digest();
function stream(key, msg) {
  let b = 0, buf = Buffer.alloc(0), pos = 0, words = 0;
  const next32 = () => { if (pos >= buf.length) { buf = hmac(key, msg(b++)); pos = 0; } const w = buf.readUInt32BE(pos); pos += 4; words++; return w; };
  const draws = [];
  const int = (n) => { let v = 0; if (n !== 1) { const limit = 2 ** 32 - (2 ** 32 % n); for (;;) { const w = next32(); if (w < limit) { v = w % n; break; } } } draws.push({ n, v }); return v; };
  return { int, draws, get words() { return words; } };
}
const seed = Buffer.from(SEED, 'hex');
const round = (game, nonce, cs = CS) => stream(seed, (b) => `fairshoe/v1/stream:${game}:${cs}:${nonce}:${b}`);
const SUITS = ['S','H','D','C'], RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const DECK = SUITS.flatMap((s) => RANKS.map((r) => r + s));
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const letters = (o) => o.map((c) => LETTERS[DECK.indexOf(c)]).join('');
function link(secret, n, i) { let h = Buffer.from(secret, 'hex'); for (let k = 0; k < n - i; k++) h = sha(h); return h; }
function shoe(key, game, table, i, decks, cs = CS) {
  const s = stream(key, (b) => `fairshoe/v1/shoe:${game}:${table}:${cs}:${i}:${b}`);
  const a = []; for (let d = 0; d < decks; d++) a.push(...DECK);
  for (let x = a.length - 1; x > 0; x--) { const j = s.int(x + 1); [a[x], a[j]] = [a[j], a[x]]; }
  return { order: a, words: s.words };
}
const salt = (key, game, table, i, cs = CS) => hmac(key, `fairshoe/v1/salt:${game}:${table}:${cs}:${i}`);
const hash = (saltBytes, order) => sha(Buffer.concat([saltBytes, Buffer.from(order.join(','), 'utf8')])).toString('hex');
const kAuto = (game, table, i, min = 52, max = 364, cs = CS) => min + stream(Buffer.from(cs, 'utf8'), (b) => `fairshoe/v1/cut-auto:${game}:${table}:${i}:${b}`).int(max - min + 1);
const rot = (o, k) => [...o.slice(k), ...o.slice(0, k)];
const bacValue = (c) => { const r = c.slice(0, -1); if (r === 'A') return 1; if (['10','J','Q','K'].includes(r)) return 0; return Number(r); };
const bacBurn = (D) => ({ cards: 1 + (bacValue(D[0]) || 10), shown: D[0] });
const byteSort = (lines) => [...lines].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
const rootOf = (lines) => { const sorted = byteSort(lines); return { hash: sha(Buffer.from(sorted.join('\n'), 'utf8')).toString('hex'), lines: sorted }; };
const crash = (r) => { const q = (97n * 2n ** 32n) / (2n ** 32n - BigInt(r)); return Number(q < 100n ? 100n : q > 2000000n ? 2000000n : q); };

const out = { alg: 'fairshoe/v1', lib: LIB, serverSeed: SEED, clientSeed: CS, chainSecret: CHAIN_SECRET };
out.serverSeedHash = sha(seed).toString('hex');
out.streamBlock0 = { gameId: 'roulette', nonce: 0, block: 0, hmac: hmac(seed, `fairshoe/v1/stream:roulette:${CS}:0:0`).toString('hex') };
out.roulette = { gameId: 'roulette', n: 37, nonces: [0,1,2,3,4], values: [0,1,2,3,4].map((x) => round('roulette', x).int(37)) };
{
  // nonces 0 to 4 and the first nonce whose spin is 37 ("00")
  const nonces = [0,1,2,3,4];
  for (let x = 5; ; x++) if (round('american-roulette', x).int(38) === 37) { nonces.push(x); break; }
  const values = nonces.map((x) => round('american-roulette', x).int(38));
  out.americanRoulette = { gameId: 'american-roulette', n: 38, nonces, values, pockets: values.map((v) => (v === 37 ? '00' : v)) };
}
out.craps = { gameId: 'craps', nonces: [0,1,2], dice: [0,1,2].map((x) => { const s = round('craps', x); return [s.int(6) + 1, s.int(6) + 1]; }) };
{
  const values = [0,1,2].map((x) => round('high-flyer', x).int(2 ** 32));
  out.highFlyer = { gameId: 'high-flyer', n: 2 ** 32, nonces: [0,1,2], values, crash: values.map(crash) };
}
out.diceBaccarat = { gameId: 'dice-baccarat', nonces: [0,1,2], dice: [0,1,2].map((x) => { const s = round('dice-baccarat', x); const d = [0,1,2,3].map(() => s.int(6) + 1); return { player: d.slice(0, 2), banker: d.slice(2) }; }) };
out.intEdges = [1, 2, 3, 2 ** 31 + 1, 2 ** 32].map((n) => { const s = round('edge', 0); const v = s.int(n); return { gameId: 'edge', nonce: 0, n, v, words: s.words }; });
// forced rejection in the round stream: first nonce where int(2^31 + 1) reads more than one word
for (let x = 0; ; x++) { const s = round('edge', x); const v = s.int(2 ** 31 + 1); if (s.words > 1) { out.rejection = { gameId: 'edge', nonce: x, n: 2 ** 31 + 1, v, words: s.words }; break; } }
// chain
const L = 3;
out.chain = { length: L, links: [0,1,2,3].map((i) => link(CHAIN_SECRET, L, i).toString('hex')), terminal2000: link(CHAIN_SECRET, 2000, 0).toString('hex'), link1999of2000: link(CHAIN_SECRET, 2000, 1999).toString('hex') };
out.root = rootOf([`baccarat:3:${out.chain.links[0]}`, `baccarat:1:${'ab'.repeat(32)}`, `baccarat:10:${'cd'.repeat(32)}`]);
out.root.note = 'lines sorted by their UTF-8 bytes: baccarat:10 before baccarat:1';
// cut range of every eight-deck shoe of v1
out.cutEdges = { min: 52, max: 364, allowed: [52, 364], refused: [51, 365] };
// baccarat table 3, shoe 1 under link 1 of the 3-link chain, cut at kAuto
{
  const key = link(CHAIN_SECRET, L, 1);
  const s = shoe(key, 'baccarat', 3, 1, 8);
  const sl = salt(key, 'baccarat', 3, 1);
  const k = kAuto('baccarat', 3, 1);
  const D = rot(s.order, k);
  out.baccarat = { gameId: 'baccarat', table: 3, shoeNo: 1, decks: 8, link: key.toString('hex'), first10: s.order.slice(0, 10), words: s.words, order: letters(s.order),
    salt: sl.toString('hex'), shoeHash: hash(sl, s.order), shoeHashHexSalt: sha(Buffer.concat([Buffer.from(sl.toString('hex'), 'utf8'), Buffer.from(s.order.join(','), 'utf8')])).toString('hex'),
    autoCut: k, cut: k, dealtFirst10: D.slice(0, 10), burn: bacBurn(D), endAt: 364, atEndAtMinus1: D[363], atEndAt364: D[364] };
}
// blackjack solo table, shoe 2 under link 2, cut at kAuto (the deal without the player's cut), no cut card
{
  const key = link(CHAIN_SECRET, L, 2);
  const s = shoe(key, 'solo-classic', 1, 2, 8);
  const sl = salt(key, 'solo-classic', 1, 2);
  const k = kAuto('solo-classic', 1, 2);
  const D = rot(s.order, k);
  out.blackjack = { gameId: 'solo-classic', table: 1, shoeNo: 2, decks: 8, link: key.toString('hex'), first10: s.order.slice(0, 10), words: s.words, salt: sl.toString('hex'), shoeHash: hash(sl, s.order), autoCut: k, cut: k, endAt: null, dealtFirst10: D.slice(0, 10), at207: D[207], at208: D[208] };
}
// forced rejection while shuffling: first shoe number (key = server seed) whose 8-deck shuffle reads more than 415 words
for (let i = 1; ; i++) { const s = shoe(seed, 'baccarat', 1, i, 8); if (s.words > 415) { out.shuffleRejection = { key: SEED, gameId: 'baccarat', table: 1, shoeNo: i, words: s.words, first10: s.order.slice(0, 10) }; break; } }
// burns: the first shoes (key = server seed, baccarat table 1, cut at kAuto) whose first dealt card is a ten or a picture, and an ace
{
  const found = {};
  for (let i = 1; !(found.ten && found.ace); i++) {
    const D = rot(shoe(seed, 'baccarat', 1, i, 8).order, kAuto('baccarat', 1, i));
    const v = bacValue(D[0]);
    if (v === 0 && !found.ten) found.ten = { key: SEED, gameId: 'baccarat', table: 1, shoeNo: i, cut: kAuto('baccarat', 1, i), first: D[0], burn: bacBurn(D) };
    if (v === 1 && !found.ace) found.ace = { key: SEED, gameId: 'baccarat', table: 1, shoeNo: i, cut: kAuto('baccarat', 1, i), first: D[0], burn: bacBurn(D) };
  }
  out.burns = found;
}
// kAuto: smallest and largest value over shoe numbers 1..2000 at baccarat table 1 with the client seed above
let lo = 999, hi = -1; for (let i = 1; i <= 2000; i++) { const k = kAuto('baccarat', 1, i); lo = Math.min(lo, k); hi = Math.max(hi, k); }
out.autoCutSpan = { gameId: 'baccarat', table: 1, clientSeed: CS, shoeNos: [1, 2000], min: lo, max: hi, note: 'min and max of kAuto over shoes 1 to 2000 of baccarat table 1, cut range 52 to 364' };
// two tables, a chain each: table 2's shoe 1 ends after table 1's shoe 2 (reverse order); no revealed link leads into the other chain
{
  const secretOf = (t) => sha(Buffer.concat([Buffer.from(CHAIN_SECRET, 'hex'), Buffer.from([t])])).toString('hex');
  const a = secretOf(1), b = secretOf(2);
  out.twoChains = {
    gameId: 'baccarat', length: L,
    tables: [{ table: 1, secret: a, links: [0,1,2,3].map((i) => link(a, L, i).toString('hex')) }, { table: 2, secret: b, links: [0,1,2,3].map((i) => link(b, L, i).toString('hex')) }],
    reveals: [{ table: 1, shoeNo: 1 }, { table: 1, shoeNo: 2 }, { table: 2, shoeNo: 1 }],
    note: 'revealed in this order; hashing a revealed link of one table never gives a link of the other',
  };
}

// ------------------------------------------------------------------ complete records (SPEC section 7)
const pairOf = (gameId, seedId, root, lastNonce, lastShoes = []) => ({ seedId, gameId, serverSeed: SEED, serverSeedHash: sha(seed).toString('hex'), clientSeed: CS, clientSeedBy: 'player', lastNonce, lastShoes, root, committedAt: 1000, clientSeedAt: 2000, revealedAt: 9000 });
/** The pair as the player kept it before sending the client seed (FairInfo.active plus the game and the seed sent). */
const keptOf = (p) => ({ seedId: p.seedId, gameId: p.gameId, serverSeedHash: p.serverSeedHash, root: p.root, clientSeed: CS, clientSeedBy: 'player', committedAt: p.committedAt, clientSeedAt: p.clientSeedAt });
function cardShoeRecord({ gameId, table, shoeNo, seedId, chainId, shoeId, root, terminal, key, cut, by, burn, rounds, status, rules }) {
  const s = shoe(key, gameId, table, shoeNo, 8);
  const sl = salt(key, gameId, table, shoeNo);
  const k = kAuto(gameId, table, shoeNo);
  const at = by === 'auto' ? k : cut;
  const D = rot(s.order, at);
  const b = burn ? bacBurn(D) : null;
  const commit = { alg: 'fairshoe/v1', shoe: shoeId, gameId, table, shoeNo, decks: 8,
    origin: { kind: 'chain', seedId, chainId, index: shoeNo, prevLink: sha(key).toString('hex'), terminal, root: root.hash },
    clientSeed: CS, clientSeedBy: 'player', shoeHash: hash(sl, s.order), cutRange: [52, 364], cutPolicy: rules.cutPolicy, autoCut: k, endAt: rules.endAt, burnRule: rules.burn, at: 3000 };
  let next = b ? b.cards : 0;
  const rs = rounds.map(([roundId, n]) => { const r = { roundId, from: next, to: next + n }; next += n; return r; });
  const reveal = { shoe: shoeId, status, link: key.toString('hex'), salt: sl.toString('hex'), order: letters(s.order), cut: { at, by }, burn: b, rounds: rs, at: 8000 };
  return { commit, reveal, D };
}
const proofOf = (o) => ({ v: 1, alg: 'fairshoe/v1', lib: LIB, serverSeedHash: sha(seed).toString('hex'), clientSeed: CS, clientSeedBy: 'player', serverSeed: SEED, engineVersion: 1, at: 5000, ...o });
const DT_RANK = { A: 1, J: 11, Q: 12, K: 13 };
const dtRank = (c) => DT_RANK[c.slice(0, -1)] ?? Number(c.slice(0, -1));
{
  // Dragon Tiger: one shoe (player's cut at 200), two rounds and a free hand between them, shuffled early.
  const seedId = 'sd_vectordragon01';
  const terminal = out.chain.links[0];
  const root = rootOf([`dragon-tiger:1:${terminal}`]);
  const x = cardShoeRecord({ gameId: 'dragon-tiger', table: 1, shoeNo: 1, seedId, chainId: 'ch_vectordragon01', shoeId: 'sh_vectordragon01', root, terminal, key: link(CHAIN_SECRET, L, 1), cut: 200, by: 'player', burn: true,
    rounds: [['R-1', 2], [null, 2], ['R-2', 2]], status: 'shuffled', rules: { cutPolicy: 'player', endAt: 364, burn: 'bac-value' } });
  const hand = (r, no) => {
    const [dragon, tiger] = x.D.slice(r.from, r.to);
    const winner = dtRank(dragon) > dtRank(tiger) ? 'dragon' : dtRank(tiger) > dtRank(dragon) ? 'tiger' : 'tie';
    return proofOf({ id: `pf_vectordragon0${no}`, gameId: 'dragon-tiger', roundId: r.roundId, seedId, steps: [], shoes: [{ shoe: x.commit.shoe, table: 1, from: r.from, to: r.to }],
      outcome: { result: { kind: 'side', side: winner }, detail: { shoe: 1, hand: no, cards: { dragon, tiger }, winner, suited: dragon === tiger } } });
  };
  const proofs = [hand(x.reveal.rounds[0], 1), hand(x.reveal.rounds[2], 3)];
  const pair = pairOf('dragon-tiger', seedId, root, -1, [{ table: 1, shoeNo: 1 }]);
  out.records = { dragonTiger: { pair, kept: keptOf(pair), commit: x.commit, reveal: x.reveal, proofs, pairRecords: { seedId, gameId: 'dragon-tiger', proofs: proofs.map((p) => p.id), shoes: [x.commit.shoe] } } };
}
// Blackjack totals (SPEC section 6 cards): A 1 or 11, 2 to 9 their number, 10 J Q K 10.
const bjValue = (c) => { const r = c.slice(0, -1); return r === 'A' ? 1 : ['10', 'J', 'Q', 'K'].includes(r) ? 10 : Number(r); };
const bjTotal = (cs) => { const hard = cs.reduce((t, c) => t + bjValue(c), 0); return cs.some((c) => c.startsWith('A')) && hard + 10 <= 21 ? hard + 10 : hard; };
const cardObj = (c) => ({ rank: c.slice(0, -1), suit: c.slice(-1) });
/**
 * A solo blackjack round as the reference server deals it from D (SPEC section 6: box card 1 in seat order, the
 * dealer's up card, box card 2 in seat order, the dealer's hole card), every hand standing on two cards (a box in
 * `split` splits its pair first: its second card starts a hand right behind it, each takes one card), the dealer
 * drawing to 17; its outcome as the server's history entry, and what the player saw: the cards in dealing order, where
 * each went ('dealer' or { seat, hand }), the splits (before which card), the boxes it bet on.
 */
function soloRound(D, roundId, seats = [0], split = []) {
  const b = seats.length;
  const hands = new Map(seats.map((s) => [s, [[]]]));
  const dealer = [];
  const places = [];
  const splits = [];
  let at = 0;
  const give = (p) => { places.push(p); if (p === 'dealer') dealer.push(D[at]); else hands.get(p.seat)[p.hand].push(D[at]); at++; };
  for (const seat of seats) give({ seat, hand: 0 });
  give('dealer');
  for (const seat of seats) give({ seat, hand: 0 });
  give('dealer');
  for (const seat of seats) {
    if (!split.includes(seat)) continue;
    const hs = hands.get(seat);
    splits.push({ at, seat, hand: 0 });
    hs.splice(1, 0, [hs[0].pop()]);
    give({ seat, hand: 0 });
    give({ seat, hand: 1 });
  }
  while (bjTotal(dealer) < 17) give('dealer');
  const d = bjTotal(dealer);
  const list = seats.flatMap((seat) => hands.get(seat).map((cs) => {
    const p = bjTotal(cs);
    const result = d > 21 || p > d ? 'win' : p === d ? 'push' : 'lose';
    return { seat, cards: cs.map(cardObj), bet: 1000, outcome: result, payout: result === 'win' ? 2000 : result === 'push' ? 1000 : 0 };
  }));
  const totalBet = list.length * 1000, totalWin = list.reduce((t, h) => t + h.payout, 0);
  const outcome = { roundId, roundNumber: 1, tableId: 'solo-classic', tableName: 'Blackjack Solo', at: 5000, dealerCards: dealer.map(cardObj), dealerTotal: d,
    hands: list, sideBets: [], totalBet, totalWin };
  const seen = { roundId, from: 0, to: at, cards: D.slice(0, at), places, ...(splits.length > 0 ? { splits } : {}), boxes: [...seats] };
  return { cards: at, dealer, outcome, seen };
}
const SOLO_RULES = { cutPolicy: 'player', endAt: null, burn: 'none' };
{
  // Solo blackjack: one round from its own fresh shoe, cut by the player (the first cut from 173 on that deals a plain
  // round: no blackjack, no ace up), no burn, no cut card, and one draw of the round stream. The player's own records:
  // the cut asked for, the round seen with its cards in dealing order.
  const seedId = 'sd_vectorsolo0001';
  const terminal = out.chain.links[0];
  const root = rootOf([`solo-classic:1:${terminal}`]);
  const key = link(CHAIN_SECRET, L, 1);
  const order = shoe(key, 'solo-classic', 1, 1, 8).order;
  const plain = (D) => bjTotal([D[0], D[2]]) < 21 && bjTotal([D[1], D[3]]) < 21 && !D[1].startsWith('A');
  let cut = 173;
  while (!plain(rot(order, cut))) cut++;
  const r = soloRound(rot(order, cut), 'R-1');
  const x = cardShoeRecord({ gameId: 'solo-classic', table: 1, shoeNo: 1, seedId, chainId: 'ch_vectorsolo0001', shoeId: 'sh_vectorsolo0001', root, terminal, key, cut, by: 'player', burn: false,
    rounds: [['R-1', r.cards]], status: 'ended', rules: SOLO_RULES });
  const s = round('solo-classic', 0);
  s.int(2 ** 32);
  const proof = proofOf({ id: 'pf_vectorsolo0001', gameId: 'solo-classic', roundId: 'R-1', seedId, steps: [{ nonce: 0, kind: 'tx', status: 'ok', draws: s.draws, words: s.words }],
    shoes: [{ shoe: x.commit.shoe, table: 1, from: 0, to: r.cards }], outcome: r.outcome });
  const pair = pairOf('solo-classic', seedId, root, 0, [{ table: 1, shoeNo: 1 }]);
  const own = { proofs: [proof.id], shoes: [x.commit.shoe], nonce: 1, cuts: { [x.commit.shoe]: { at: cut } }, hands: { [x.commit.shoe]: [r.seen] } };
  out.records.soloBlackjack = { pair, kept: keptOf(pair), commit: x.commit, reveal: x.reveal, proofs: [proof], own, pairRecords: { seedId, gameId: 'solo-classic', proofs: [proof.id], shoes: [x.commit.shoe] } };
}
{
  // Solo blackjack with two boxes (seats 0 and 2) and a split: the first cut from 52 on whose first deal gives box 0 a
  // pair (no aces), no blackjack and no ace up. Box 0 splits (its second card starts hand 1), each split hand takes one
  // card, box 2 stands, the dealer draws to 17; the deal without a cut of the player (kAuto) fails that, so the player
  // cut. Its own pair (the chain of records.soloBlackjack, shoe 1).
  const seedId = 'sd_vectorsolo0002';
  const terminal = out.chain.links[0];
  const root = rootOf([`solo-classic:1:${terminal}`]);
  const key = link(CHAIN_SECRET, L, 1);
  const order = shoe(key, 'solo-classic', 1, 1, 8).order;
  const rank = (c) => c.slice(0, -1);
  const fits = (D) => rank(D[0]) === rank(D[3]) && rank(D[0]) !== 'A' && bjTotal([D[1], D[4]]) < 21 && !D[2].startsWith('A') && bjTotal([D[2], D[5]]) < 21;
  let cut = 52;
  while (!fits(rot(order, cut))) cut++;
  const r = soloRound(rot(order, cut), 'R-1', [0, 2], [0]);
  const x = cardShoeRecord({ gameId: 'solo-classic', table: 1, shoeNo: 1, seedId, chainId: 'ch_vectorsolo0002', shoeId: 'sh_vectorsolo0002', root, terminal, key, cut, by: 'player', burn: false,
    rounds: [['R-1', r.cards]], status: 'ended', rules: SOLO_RULES });
  const s = round('solo-classic', 0);
  s.int(2 ** 32);
  const proof = proofOf({ id: 'pf_vectorsolo0002', gameId: 'solo-classic', roundId: 'R-1', seedId, steps: [{ nonce: 0, kind: 'tx', status: 'ok', draws: s.draws, words: s.words }],
    shoes: [{ shoe: x.commit.shoe, table: 1, from: 0, to: r.cards }], outcome: r.outcome });
  const pair = pairOf('solo-classic', seedId, root, 0, [{ table: 1, shoeNo: 1 }]);
  const own = { proofs: [proof.id], shoes: [x.commit.shoe], nonce: 1, cuts: { [x.commit.shoe]: { at: cut } }, hands: { [x.commit.shoe]: [r.seen] } };
  out.records.soloSplit = { pair, kept: keptOf(pair), commit: x.commit, reveal: x.reveal, proofs: [proof], own, pairRecords: { seedId, gameId: 'solo-classic', proofs: [proof.id], shoes: [x.commit.shoe] } };
}
{
  // Roulette: nonce 0 drew and was discarded (the spin was refused), nonce 1 is the spin of round R-1.
  const seedId = 'sd_vectorroulett1';
  const d0 = round('roulette', 0); d0.int(37);
  const d1 = round('roulette', 1); const pocket = d1.int(37);
  const proof = proofOf({ id: 'pf_vectorroulett1', gameId: 'roulette', roundId: 'R-1', seedId,
    steps: [{ nonce: 0, kind: 'act', status: 'discarded', draws: d0.draws, words: d0.words }, { nonce: 1, kind: 'act', status: 'ok', draws: d1.draws, words: d1.words }],
    shoes: [], outcome: { result: { kind: 'number', n: pocket }, detail: { wheel: 'single', pocket, strikes: [] } } });
  const pair = pairOf('roulette', seedId, null, 1);
  out.records.roulette = { pair, kept: keptOf(pair), proofs: [proof], pairRecords: { seedId, gameId: 'roulette', proofs: [proof.id], shoes: [] } };
}
{
  // Negative vectors (SPEC section 9): every draw below is what the round stream gives, yet each proof must fail. A server
  // writes the draws down itself; with draws before the spin (or a second spin) it could pick the value the game reads.
  // The draw plan of a mapped game is one applied step with exactly int(37) (roulette) or int(2^32) (high flyer).
  const step = (game, ns) => { const r = round(game, 0); const v = ns.map((n) => r.int(n)); return { v, s: { nonce: 0, kind: 'act', status: 'ok', draws: r.draws, words: r.words } }; };
  const honest = round('roulette', 0).int(37);
  let pad = 1;
  while (step('roulette', [...Array(pad).fill(2), 37]).v.at(-1) !== 0) pad++;
  const padded = step('roulette', [...Array(pad).fill(2), 37]);
  const twice = step('roulette', [37, 37]);
  const fly = round('high-flyer', 0).int(2 ** 32);
  let fpad = 1;
  while (crash(step('high-flyer', [...Array(fpad).fill(2), 2 ** 32]).v.at(-1)) >= crash(fly)) fpad++;
  const flown = step('high-flyer', [...Array(fpad).fill(2), 2 ** 32]);
  const proof = (gameId, id, s, detail) => proofOf({ id, gameId, roundId: 'R-1', seedId: `sd_vectornegativ${gameId === 'roulette' ? 'r' : 'h'}`, steps: [s], shoes: [], outcome: { result: {}, detail } });
  const rp = pairOf('roulette', 'sd_vectornegativr', null, 0);
  const hp = pairOf('high-flyer', 'sd_vectornegativh', null, 0);
  out.negative = {
    note: 'consistent with the round stream, refused by the draw plan of the game (section 9)',
    roulette: { pair: rp, kept: keptOf(rp), honestPocket: honest, padding: pad,
      padded: proof('roulette', 'pf_vectornegativ1', padded.s, { wheel: 'single', pocket: 0, strikes: [] }),
      twice: proof('roulette', 'pf_vectornegativ2', twice.s, { wheel: 'single', pocket: twice.v[1], strikes: [] }) },
    highFlyer: { pair: hp, kept: keptOf(hp), honestCrash: crash(fly) / 100, padding: fpad,
      padded: proof('high-flyer', 'pf_vectornegativ3', flown.s, { crash: crash(flown.v.at(-1)) / 100 }) },
  };
}
// ------------------------------------------------------------------ the player's own records and the card rules
// Punto banco, written from SPEC section 9 alone: P1 B1 P2 B2; no more cards on a natural (8 or 9); the Player draws
// on 0 to 5; the Banker, when the Player stood, on 0 to 5, else by the value of the Player's third card.
const bacTotal = (cs) => cs.reduce((t, c) => t + bacValue(c), 0) % 10;
function tableau(D, from) {
  const player = [D[from], D[from + 2]], banker = [D[from + 1], D[from + 3]];
  let at = from + 4;
  const p = bacTotal(player), b = bacTotal(banker);
  if (p < 8 && b < 8) {
    let third = null;
    if (p <= 5) { player.push(D[at++]); third = bacValue(player[2]); }
    const draws = third === null ? b <= 5 : b <= 2 || (b === 3 && third !== 8) || (b === 4 && third >= 2 && third <= 7) || (b === 5 && third >= 4 && third <= 7) || (b === 6 && (third === 6 || third === 7));
    if (draws) banker.push(D[at++]);
  }
  const pt = bacTotal(player), bt = bacTotal(banker);
  return { player, banker, playerTotal: pt, bankerTotal: bt, winner: pt > bt ? 'player' : bt > pt ? 'banker' : 'tie', cards: at - from };
}
const twelveSecret = (t) => sha(Buffer.concat([Buffer.from(CHAIN_SECRET, 'hex'), Buffer.from([0x40 + t])])).toString('hex');
{
  // Baccarat (12 tables): the player sits at table 3, cuts shoe 1 at 150, plays a free hand, then bets on two hands;
  // the shoe is shuffled early. The player's own records: the cut, the three hands it saw, the table of each bet.
  const seedId = 'sd_vectorbaccara1';
  const secrets = Array.from({ length: 12 }, (_, i) => twelveSecret(i + 1));
  const root = rootOf(secrets.map((s, i) => `baccarat:${i + 1}:${link(s, L, 0).toString('hex')}`));
  const key = link(secrets[2], L, 1);
  const s = shoe(key, 'baccarat', 3, 1, 8);
  const sl = salt(key, 'baccarat', 3, 1);
  const k = kAuto('baccarat', 3, 1);
  const D = rot(s.order, 150);
  const burn = bacBurn(D);
  const ids = [null, 'R-1', 'R-2'];
  const hands = [];
  let at = burn.cards;
  for (const roundId of ids) { const h = tableau(D, at); hands.push({ roundId, from: at, to: at + h.cards, h }); at += h.cards; }
  const commit = { alg: 'fairshoe/v1', shoe: 'sh_vectorbaccara1', gameId: 'baccarat', table: 3, shoeNo: 1, decks: 8,
    origin: { kind: 'chain', seedId, chainId: 'ch_vectorbaccara3', index: 1, prevLink: sha(key).toString('hex'), terminal: link(secrets[2], L, 0).toString('hex'), root: root.hash },
    clientSeed: CS, clientSeedBy: 'player', shoeHash: hash(sl, s.order), cutRange: [52, 364], cutPolicy: 'player', autoCut: k, endAt: 364, burnRule: 'bac-value', at: 3000 };
  const reveal = { shoe: commit.shoe, status: 'shuffled', link: key.toString('hex'), salt: sl.toString('hex'), order: letters(s.order), cut: { at: 150, by: 'player' }, burn,
    rounds: hands.map(({ roundId, from, to }) => ({ roundId, from, to })), at: 8000 };
  const proofs = hands.slice(1).map(({ roundId, from, to, h }, i) => proofOf({ id: `pf_vectorbaccara${i + 1}`, gameId: 'baccarat', roundId, seedId, steps: [],
    shoes: [{ shoe: commit.shoe, table: 3, from, to }],
    outcome: { result: { kind: 'side', side: h.winner }, detail: { variant: 'classic', table: 3, shoe: 1, hand: i + 2, player: h.player, banker: h.banker, playerTotal: h.playerTotal, bankerTotal: h.bankerTotal, winner: h.winner, strikes: [], multiplier: 1, fee: 0 } } }));
  const pair = pairOf('baccarat', seedId, root, -1, Array.from({ length: 12 }, (_, i) => ({ table: i + 1, shoeNo: i === 2 ? 1 : 0 })));
  const own = { proofs: proofs.map((p) => p.id), shoes: [commit.shoe], nonce: 0, cuts: { [commit.shoe]: { at: 150 } }, hands: { [commit.shoe]: reveal.rounds }, tables: { 'R-1': 3, 'R-2': 3 } };
  out.ownRecords = {
    note: "complete records with the player's own records (cut asked for, hands seen, table bet at): provable only with them",
    baccarat: { pair, kept: keptOf(pair), commit, reveal, proofs, own, pairRecords: { seedId, gameId: 'baccarat', proofs: own.proofs, shoes: [commit.shoe] } },
  };
  // Negative: each record below is consistent with the streams and the commitments, yet must fail.
  const flipped = proofs[0].outcome.detail.winner === 'banker' ? 'player' : 'banker';
  const extra = hands[0].h.cards === 6 ? 5 : hands[0].h.cards + 1;
  const skipped = { ...reveal, rounds: [{ roundId: null, from: burn.cards, to: burn.cards + extra }, ...reveal.rounds.slice(1).map((r) => ({ ...r }))] };
  // Shift the later hands by the extra card, as a server would that skipped it.
  { let a = burn.cards + extra; skipped.rounds = [skipped.rounds[0], ...hands.slice(1).map(({ roundId }) => { const h = tableau(D, a); const r = { roundId, from: a, to: a + h.cards }; a += h.cards; return r; })]; }
  out.negativeOwn = {
    note: 'consistent with the streams and the commitments, refused by the card rules of section 9 or by the player\'s own records (section 8)',
    baccaratWinner: { kept: keptOf(pair), commit, reveal, own, proof: { ...proofs[0], outcome: { ...proofs[0].outcome, detail: { ...proofs[0].outcome.detail, winner: flipped } } }, stated: flipped, honest: proofs[0].outcome.detail.winner },
    baccaratFreeHandTooLong: { kept: keptOf(pair), commit, reveal: skipped, tableauCards: hands[0].h.cards, dealt: extra },
    baccaratOtherTable: { kept: keptOf(pair), commit, reveal, own: { ...own, tables: { 'R-1': 5, 'R-2': 3 } }, proof: proofs[0], betAt: 5 },
  };
}
{
  // Dragon Tiger: the player played R-1 and R-2 and asked for no free hand; the shoe of records.dragonTiger lists one
  // between them. And the same shoe recorded with a player's cut at 202 when the player cut at 200.
  const dt = out.records.dragonTiger;
  const [r1, , r2] = dt.reveal.rounds;
  out.negativeOwn.dragonTigerFreeHand = { kept: dt.kept, commit: dt.commit, reveal: dt.reveal, proofs: dt.proofs, pair: dt.pair, own: { proofs: dt.proofs.map((p) => p.id), shoes: [dt.commit.shoe], nonce: 0, cuts: { [dt.commit.shoe]: { at: 200 } }, hands: { [dt.commit.shoe]: [{ ...r1 }, { roundId: 'R-2', from: r1.to, to: r1.to + 2 }] } }, slipped: { roundId: null, from: r1.to, to: r2.from } };
  const moved = cardShoeRecord({ gameId: 'dragon-tiger', table: 1, shoeNo: 1, seedId: dt.kept.seedId, chainId: dt.commit.origin.chainId, shoeId: dt.commit.shoe, root: dt.kept.root, terminal: dt.commit.origin.terminal, key: link(CHAIN_SECRET, L, 1), cut: 202, by: 'player', burn: true,
    rounds: [['R-1', 2]], status: 'shuffled', rules: { cutPolicy: 'player', endAt: 364, burn: 'bac-value' } });
  out.negativeOwn.dragonTigerCutMoved = { kept: dt.kept, commit: moved.commit, reveal: moved.reveal, askedCut: 200, recordedCut: 202 };
}
{
  // Solo blackjack, against the records of records.soloBlackjack: a shoe for one round that lists a hand of seven cards
  // before the round (cards skipped), one that lists two rounds, a round whose slice is two cards longer than the cards
  // played (the outcome names fewer), an outcome that names a card the slice does not have, the cards seen with the
  // hole card and the player's second card swapped (dealt in another order than the shoe's), a cut moved by 2; the
  // same cards in the same order dealt to other places: an outcome that gives the box D0, D3 (the dealer D1, D2, D4),
  // one whose box and dealer swapped, the cards seen going to the dealer first (the server sent them so), a box the
  // player did not bet on taking cards (seven cards: the player's box gets D0, D3), every card shown face down.
  const bj = out.records.soloBlackjack;
  const cut = bj.reveal.cut.at;
  const base = { gameId: 'solo-classic', table: 1, shoeNo: 1, seedId: bj.kept.seedId, chainId: bj.commit.origin.chainId, shoeId: bj.commit.shoe, root: bj.kept.root, terminal: bj.commit.origin.terminal, key: link(CHAIN_SECRET, L, 1), cut, by: 'player', burn: false, status: 'ended', rules: SOLO_RULES };
  const n = bj.reveal.rounds[0].to;
  const x = cardShoeRecord({ ...base, rounds: [[null, 7], ['R-1', n]] });
  const y = cardShoeRecord({ ...base, rounds: [['R-1', n], ['R-2', 6]] });
  out.negativeOwn.soloSkipped = { kept: bj.kept, commit: x.commit, reveal: x.reveal };
  out.negativeOwn.soloTwoRounds = { kept: bj.kept, commit: y.commit, reveal: y.reveal };
  const longer = cardShoeRecord({ ...base, rounds: [['R-1', n + 2]] });
  const proof = bj.proofs[0];
  const seen = bj.own.hands[bj.commit.shoe][0];
  out.negativeOwn.soloLonger = { kept: bj.kept, pair: bj.pair, commit: longer.commit, reveal: longer.reveal,
    proof: { ...proof, shoes: [{ ...proof.shoes[0], to: n + 2 }] }, own: { ...bj.own, hands: { [bj.commit.shoe]: [{ ...seen, to: n + 2, cards: longer.D.slice(0, n + 2), places: [...seen.places, 'dealer', 'dealer'] }] } }, named: n, slice: n + 2 };
  const other = longer.D[n];
  out.negativeOwn.soloOtherCard = { kept: bj.kept, pair: bj.pair, commit: bj.commit, reveal: bj.reveal, own: bj.own,
    proof: { ...proof, outcome: { ...proof.outcome, dealerCards: [...proof.outcome.dealerCards.slice(0, -1), cardObj(other)] } }, card: other };
  const swapped = [...seen.cards];
  [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
  out.negativeOwn.soloSwapped = { kept: bj.kept, pair: bj.pair, commit: bj.commit, reveal: bj.reveal, own: { ...bj.own, hands: { [bj.commit.shoe]: [{ ...seen, cards: swapped }] } }, seen: swapped };
  const moved = cardShoeRecord({ ...base, cut: cut + 2, rounds: [['R-1', n]] });
  out.negativeOwn.soloCutMoved = { kept: bj.kept, commit: moved.commit, reveal: moved.reveal, askedCut: cut, recordedCut: cut + 2 };
  const D = seen.cards;
  const forge = (box, dealer) => ({ ...proof, outcome: { ...proof.outcome, hands: [{ ...proof.outcome.hands[0], cards: box.map((i) => cardObj(D[i])) }], dealerCards: dealer.map((i) => cardObj(D[i])) } });
  out.negativeOwn.soloOtherPlaces = { kept: bj.kept, pair: bj.pair, commit: bj.commit, reveal: bj.reveal, own: bj.own,
    proofs: [forge([0, 3], [1, 2, ...D.slice(4).map((_, i) => i + 4)]), forge([1, 3], [0, 2, ...D.slice(4).map((_, i) => i + 4)])] };
  const dealerFirst = [{ ...seen, places: ['dealer', { seat: 0, hand: 0 }, { seat: 0, hand: 0 }, 'dealer', ...seen.places.slice(4)] }];
  out.negativeOwn.soloPlacesOffRule = { kept: bj.kept, pair: bj.pair, commit: bj.commit, reveal: bj.reveal, own: { ...bj.own, hands: { [bj.commit.shoe]: dealerFirst } } };
  // A box nobody bet on (seat 1) in the round of soloLonger (seven cards): the dealing rule over two boxes.
  const phantomPlaces = [{ seat: 0, hand: 0 }, { seat: 1, hand: 0 }, 'dealer', { seat: 0, hand: 0 }, { seat: 1, hand: 0 }, 'dealer', 'dealer'];
  const L7 = longer.D.slice(0, n + 2);
  out.negativeOwn.soloPhantomBox = { kept: bj.kept, pair: bj.pair, commit: longer.commit, reveal: longer.reveal,
    proof: { ...proof, shoes: [{ ...proof.shoes[0], to: n + 2 }], outcome: { ...proof.outcome, hands: [{ ...proof.outcome.hands[0], cards: [L7[0], L7[3]].map(cardObj) }, { seat: 1, cards: [L7[1], L7[4]].map(cardObj), bet: 0, outcome: 'lose', payout: 0 }], dealerCards: [L7[2], L7[5], L7[6]].map(cardObj) } },
    own: { ...bj.own, hands: { [bj.commit.shoe]: [{ roundId: 'R-1', from: 0, to: n + 2, cards: L7, places: phantomPlaces, boxes: [0] }] } } };
  out.negativeOwn.soloFaceDown = { kept: bj.kept, pair: bj.pair, commit: bj.commit, reveal: bj.reveal, own: { ...bj.own, hands: { [bj.commit.shoe]: [{ ...seen, cards: seen.cards.map(() => null) }] } } };
}
{
  // Roulette: the padded spin of negative.roulette without its outcome detail (the draw plan must not switch off), and
  // a second pair under a client seed already sent for the first (the server knew it before making the pair).
  const n = out.negative.roulette;
  const { detail: _, ...result } = n.padded.outcome;
  const p2 = { ...pairOf('roulette', 'sd_vectorreused02', null, 0), committedAt: 10000, clientSeedAt: 11000, revealedAt: 19000 };
  const d = round('roulette', 0); const pocket = d.int(37);
  out.negativeOwn.rouletteNoDetail = { kept: n.kept, proof: { ...n.padded, outcome: result } };
  out.negativeOwn.seedReused = { first: n.kept, kept: keptOf(p2), pair: p2,
    proof: proofOf({ id: 'pf_vectorreused02', gameId: 'roulette', roundId: 'R-1', seedId: p2.seedId, steps: [{ nonce: 0, kind: 'act', status: 'ok', draws: d.draws, words: d.words }], shoes: [], outcome: { result: { kind: 'number', n: pocket }, detail: { wheel: 'single', pocket, strikes: [] } } }) };
}
console.log(JSON.stringify(out, null, 2));
