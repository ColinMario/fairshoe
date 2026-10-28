/** Independent card/action/settlement replay for the published blackjack rules, including Free Double and R1. */
import { isCardCode } from './shoe.ts';
import { blackjackTotal, blackjackValue, classicCashoutFactor } from './blackjack-value.ts';
import type { BlackjackChoice, BlackjackGameplay, BlackjackWager } from './gameplay.ts';

export type BlackjackRuleId = BlackjackGameplay['rules'];
export interface ReplayedHand {
  seat: number; hand: number; cards: string[]; bet: number; free: number;
  outcome: 'win' | 'lose' | 'push' | 'blackjack' | 'surrender' | 'cashout'; payout: number;
  fromSplit: boolean; splitAces: boolean; doubled: boolean; early: boolean;
  multiplierApplied?: number; cashoutFactor?: number;
  behind: Array<{ playerId: string; amount: number }>;
}
export interface ReplayedBox {
  seat: number; staked: number; returned: number; fee: number;
  hands: ReplayedHand[];
  sideBets: Array<{ seat: number; spot: 'pp' | 'p21'; bet: number; outcome: string | null; payout: number }>;
  insurance: { taken: boolean; evenMoney: boolean; amount: number; payout: number } | null;
  earned: null | { value: number; coversUpTo: number; category: string };
  behind: Array<{ playerId: string; amount: number; payout: number }>;
}
export interface BlackjackReplay {
  boxes: ReplayedBox[]; dealer: string[]; dealerTotal: number; consumed: number;
  totalBet: number; totalWin: number;
  places: Array<'dealer' | { seat: number; hand: number }>;
  decisions: Array<{ seat: number; hand: number; at: number; cards: string[]; up: string; legal: string[] }>;
  insuranceOffers: Array<{ seat: number; evenMoney: boolean; amount: number }>;
}
const amount = (n: number) => Number.isSafeInteger(n) && n >= 0;
const rank = (c: string) => c.slice(0, -1);
const sidePayouts = (w: BlackjackWager, own: string[], up: string, enabled: boolean): ReplayedBox['sideBets'] => {
  const out: ReplayedBox['sideBets'] = [];
  const a = own[0]!, b = own[1]!;
  const red = (c: string) => c.endsWith('H') || c.endsWith('D');
  if (w.pp) {
    const outcome = rank(a) !== rank(b) ? null : a === b ? 'perfect' : red(a) === red(b) ? 'colored' : 'mixed';
    const odds = outcome === 'perfect' ? 25 : outcome === 'colored' ? 12 : 6;
    out.push({ seat: w.seat, spot: 'pp', bet: w.pp, outcome: enabled ? outcome : null, payout: !enabled ? w.pp : outcome ? w.pp * (1 + odds) : 0 });
  }
  if (w.p21) {
    const rs = [a, b, up].map((c) => rank(c) === 'A' ? 14 : rank(c) === 'K' ? 13 : rank(c) === 'Q' ? 12 : rank(c) === 'J' ? 11 : Number(rank(c))).sort((x, y) => x - y);
    const flush = a.slice(-1) === b.slice(-1) && b.slice(-1) === up.slice(-1);
    const trips = rank(a) === rank(b) && rank(b) === rank(up);
    const straight = new Set(rs).size === 3 && (rs[2]! - rs[0]! === 2 || rs.join(',') === '2,3,14');
    const outcome = trips && flush ? 'suitedTrips' : straight && flush ? 'straightFlush' : trips ? 'threeOfAKind' : straight ? 'straight' : flush ? 'flush' : null;
    const odds: Record<string, number> = { suitedTrips: 100, straightFlush: 40, threeOfAKind: 30, straight: 10, flush: 5 };
    out.push({ seat: w.seat, spot: 'p21', bet: w.p21, outcome: enabled ? outcome : null, payout: !enabled ? w.p21 : outcome ? w.p21 * (1 + odds[outcome]!) : 0 });
  }
  return out;
};
const paid = (outcome: ReplayedHand['outcome'], own: number, free = 0): number => outcome === 'blackjack' ? own + Math.floor(own * 3 / 2) : outcome === 'win' ? 2 * own + free : outcome === 'push' ? own : outcome === 'surrender' ? Math.floor(own / 2) : 0;

export function replayBlackjack(input: { rules: BlackjackRuleId; boxes: readonly BlackjackWager[]; cards: readonly string[]; actions: readonly BlackjackChoice[]; insurance: readonly { seat: number; take: boolean }[]; board?: Readonly<Record<string, number>> }): BlackjackReplay {
  const { cards } = input;
  if (!['solo/g7', 'solo/legacy', 'free-double/g7', 'multiplier/set-a-r1', 'multiplier/legacy', 'lounge/g1'].includes(input.rules)) throw new Error('unknown blackjack payout rule');
  if (cards.some((c) => !isCardCode(c))) throw new Error('invalid blackjack card');
  const multiplier = input.rules.startsWith('multiplier/'), freeBet = input.rules === 'free-double/g7', lounge = input.rules === 'lounge/g1';
  const cashout = input.rules === 'solo/g7' || input.rules === 'solo/legacy';
  const wagers = [...input.boxes].sort((a, b) => a.seat - b.seat);
  if (!wagers.length || new Set(wagers.map((w) => w.seat)).size !== wagers.length || wagers.some((w) => !Number.isInteger(w.seat) || w.seat < 0 || w.seat > 6 || !amount(w.main) || !w.main || !amount(w.pp) || !amount(w.p21))) throw new Error('invalid blackjack wagers');
  let cursor = 0, action = 0;
  const places: BlackjackReplay['places'] = [];
  const draw = (place: BlackjackReplay['places'][number]) => { places.push(place); const c = cards[cursor++]; if (!c) throw new Error('the blackjack shoe slice ends before play finishes'); return c; };
  const makeHand = (w: BlackjackWager, list: string[], split = false, free = false): ReplayedHand => ({ seat: w.seat, hand: 0, cards: list, bet: free ? 0 : w.main, free: free ? w.main : 0, outcome: 'lose', payout: 0, fromSplit: split, splitAces: false, doubled: false, early: false, behind: [] });
  const boxes = wagers.map((w): ReplayedBox => ({ seat: w.seat, staked: w.main + w.pp + w.p21 + (multiplier ? w.main : 0), returned: 0, fee: multiplier ? w.main : 0, hands: [makeHand(w, [])], sideBets: [], insurance: null, earned: null, behind: (w.behind ?? []).map((b) => ({ ...b, payout: 0 })) }));
  boxes.forEach((b, i) => { b.hands[0]!.cards.push(draw({ seat: b.seat, hand: 0 })); b.hands[0]!.behind = (wagers[i]!.behind ?? []).map((x) => ({ ...x })); });
  const dealer = [draw('dealer')];
  boxes.forEach((b) => b.hands[0]!.cards.push(draw({ seat: b.seat, hand: 0 }))); dealer.push(draw('dealer'));
  const initialBJ = blackjackTotal(dealer).natural, up = dealer[0]!;
  const insuranceOffers: BlackjackReplay['insuranceOffers'] = [];
  const choices = new Map<number, boolean>();
  for (const c of input.insurance) { if (typeof c.take !== 'boolean' || choices.has(c.seat) || !boxes.some((b) => b.seat === c.seat)) throw new Error('duplicate or foreign insurance choice'); choices.set(c.seat, c.take); }
  if (blackjackValue(up) !== 1 && choices.size) throw new Error('insurance was not offered');
  boxes.forEach((b, i) => {
    const w = wagers[i]!, hand = b.hands[0]!;
    b.sideBets = sidePayouts(w, hand.cards, up, !multiplier);
    if (blackjackValue(up) === 1) {
      const evenMoney = !multiplier && blackjackTotal(hand.cards).natural;
      const ins = { taken: choices.get(b.seat) ?? false, evenMoney, amount: evenMoney ? 0 : Math.floor(w.main / 2), payout: 0 };
      insuranceOffers.push({ seat: b.seat, evenMoney, amount: ins.amount });
      if (ins.taken) {
        if (evenMoney) { hand.early = true; hand.outcome = 'win'; hand.payout = 2 * hand.bet; ins.payout = hand.payout; }
        else { b.staked += ins.amount; ins.payout = initialBJ ? 3 * ins.amount : 0; }
      }
      b.insurance = ins;
    }
  });
  const decisions: BlackjackReplay['decisions'] = [];
  const peekBlackjack = initialBJ && (blackjackValue(up) === 1 || lounge && blackjackValue(up) === 10);
  if (!peekBlackjack) for (let bi = 0; bi < boxes.length; bi++) {
    const box = boxes[bi]!, w = wagers[bi]!;
    for (let hi = 0; hi < box.hands.length; hi++) {
      const hand = box.hands[hi]!; hand.hand = hi;
      if (hand.early) continue;
      if (hand.cards.length === 1) hand.cards.push(draw({ seat: box.seat, hand: hi }));
      for (;;) {
        const t = blackjackTotal(hand.cards), natural = !hand.fromSplit && t.natural;
        if (natural || t.best >= 21 || hand.splitAces) break;
        const two = hand.cards.length === 2;
        const canSplit = two && blackjackValue(hand.cards[0]!) === blackjackValue(hand.cards[1]!) && box.hands.length < (freeBet ? 4 : 2);
        const legal = ['hit', 'stand', ...(two ? ['double'] : []), ...(canSplit ? ['split'] : []), ...(cashout ? ['cashout'] : [])];
        decisions.push({ seat: box.seat, hand: hi, at: cursor, cards: [...hand.cards], up, legal: [...legal] });
        const choice = input.actions[action++];
        if (!choice || choice.seat !== box.seat || choice.hand !== hi || choice.at !== cursor || !legal.includes(choice.action)) throw new Error(`missing or illegal blackjack action at card ${cursor}, box ${box.seat}, hand ${hi}`);
        if (choice.action === 'stand') break;
        if (choice.action === 'cashout') {
          hand.cashoutFactor = classicCashoutFactor(hand.cards, up, hand.fromSplit, input.rules === 'solo/legacy');
          hand.payout = Number(BigInt(hand.bet) * BigInt(hand.cashoutFactor) / 100n); hand.outcome = 'cashout'; hand.early = true; break;
        }
        if (choice.action === 'hit') { hand.cards.push(draw({ seat: box.seat, hand: hi })); continue; }
        if (choice.action === 'double') {
          const free = freeBet && !t.soft && [9, 10, 11].includes(t.best);
          if (free) hand.free += w.main; else { hand.bet += w.main; box.staked += w.main; }
          hand.doubled = true; hand.cards.push(draw({ seat: box.seat, hand: hi })); break;
        }
        if (choice.action === 'split') {
          const moved = hand.cards.pop()!;
          const free = freeBet && rank(hand.cards[0]!) === rank(moved) && blackjackValue(moved) !== 10;
          const next = makeHand(w, [moved], true, free);
          hand.fromSplit = true; hand.splitAces = rank(moved) === 'A'; next.splitAces = hand.splitAces;
          if (!free) box.staked += w.main;
          for (const share of hand.behind) { const half = Math.floor(share.amount / 2); share.amount -= half; if (half) next.behind.push({ playerId: share.playerId, amount: half }); }
          box.hands.splice(hi + 1, 0, next); hand.cards.push(draw({ seat: box.seat, hand: hi })); continue;
        }
      }
    }
  }
  if (action !== input.actions.length) throw new Error('blackjack actions continue after the last legal decision');
  const needsDealer = boxes.some((b) => b.hands.some((h) => !h.early && blackjackTotal(h.cards).best <= 21 && (h.fromSplit || !blackjackTotal(h.cards).natural)));
  if (!initialBJ && needsDealer) while (blackjackTotal(dealer).best < 17) dealer.push(draw('dealer'));
  if (cursor !== cards.length) throw new Error('the blackjack shoe slice contains unused cards');
  const dt = blackjackTotal(dealer);
  boxes.forEach((box, i) => {
    const w = wagers[i]!;
    box.hands.forEach((h, hi) => {
      h.hand = hi;
      if (h.early) return;
      const t = blackjackTotal(h.cards), natural = !h.fromSplit && t.natural;
      h.outcome = t.best > 21 ? 'lose' : natural ? initialBJ ? 'push' : 'blackjack' : initialBJ ? 'lose' : freeBet && dt.hard === 22 ? 'push' : dt.best > 21 || t.best > dt.best ? 'win' : t.best === dt.best ? 'push' : 'lose';
      h.payout = paid(h.outcome, h.bet, h.free);
    });
    if (multiplier && w.pending) {
      if (!amount(w.pending.coversUpTo) || !Number.isInteger(w.pending.value) || w.pending.value < 1 || w.pending.value > 25) throw new Error('invalid carried multiplier');
      const choices = input.rules === 'multiplier/legacy' ? box.hands : box.hands.slice(0, 1);
      let best: ReplayedHand | null = null, gain = -Infinity;
      const boosted = (h: ReplayedHand) => { const covered = Math.min(h.bet, w.pending!.coversUpTo), excess = h.bet - covered; return h.bet + covered * w.pending!.value + (h.outcome === 'blackjack' ? Math.floor(excess * 3 / 2) : excess) + h.free; };
      for (const h of choices) if (!h.early && (h.outcome === 'win' || h.outcome === 'blackjack') && boosted(h) - h.payout > gain) { best = h; gain = boosted(h) - h.payout; }
      if (best) { best.payout = boosted(best); best.multiplierApplied = w.pending.value; }
    }
    if (multiplier) {
      if (!input.board) throw new Error('no replayed multiplier board');
      for (const h of box.hands) if (!h.early && (h.outcome === 'win' || h.outcome === 'blackjack')) {
        const total = blackjackTotal(h.cards), category = h.outcome === 'blackjack' ? 'bj' : total.best <= 17 ? 'le17' : String(total.best);
        const value = input.board[category];
        if (!Number.isInteger(value) || value! < 1) throw new Error('invalid replayed multiplier category');
        if (!box.earned || value! > box.earned.value) box.earned = { value: value!, coversUpTo: box.fee, category };
      }
    }
    for (const behind of box.behind) for (const h of box.hands) for (const share of h.behind) if (share.playerId === behind.playerId) {
      behind.payout += h.outcome === 'cashout' ? Number(BigInt(share.amount) * BigInt(h.cashoutFactor!) / 100n) : paid(h.early ? initialBJ ? 'push' : 'blackjack' : h.outcome, share.amount);
    }
    box.returned = box.hands.reduce((s, h) => s + h.payout, 0) + box.sideBets.reduce((s, b) => s + b.payout, 0) + (box.insurance?.taken && !box.insurance.evenMoney ? box.insurance.payout : 0);
  });
  return { boxes, dealer, places, dealerTotal: dt.best, consumed: cursor, decisions, insuranceOffers, totalBet: boxes.reduce((s, b) => s + b.staked, 0), totalWin: boxes.reduce((s, b) => s + b.returned, 0) };
}
