/** Independent infinite-deck Cash Out evaluator for the published classic rules. No engine imports. */
const P = Array.from({ length: 11 }, (_, v) => v === 0 ? 0 : v === 10 ? 4 / 13 : 1 / 13);
export function blackjackValue(card: string): number { const r = card.slice(0, -1); return r === 'A' ? 1 : ['10', 'J', 'Q', 'K'].includes(r) ? 10 : Number(r); }
export function blackjackTotal(cards: readonly string[]): { hard: number; best: number; soft: boolean; natural: boolean } {
  const hard = cards.reduce((sum, c) => sum + blackjackValue(c), 0), ace = cards.some((c) => blackjackValue(c) === 1);
  const soft = ace && hard + 10 <= 21;
  return { hard, best: soft ? hard + 10 : hard, soft, natural: cards.length === 2 && (soft ? hard + 10 : hard) === 21 };
}
const best = (hard: number, ace: boolean) => ace && hard + 10 <= 21 ? hard + 10 : hard;

export function classicCashoutFactor(cards: readonly string[], upCard: string, split: boolean, legacy = false): number {
  const up = blackjackValue(upCard), total = blackjackTotal(cards);
  if (cards.length < 2 || total.best >= 21) throw new Error('no cashout decision for this hand');
  const dealerMemo = new Map<string, number[]>();
  const dealer = (hard: number, ace: boolean): number[] => {
    const key = `${hard}:${ace}`, previous = dealerMemo.get(key);
    if (previous) return previous;
    const out = Array<number>(7).fill(0), value = best(hard, ace);
    if (hard > 21) out[5] = 1;
    else if (value >= 17) out[value - 17] = 1;
    else for (let v = 1; v <= 10; v++) { const next = dealer(hard + v, ace || v === 1); next.forEach((p, i) => { out[i]! += P[v]! * p; }); }
    dealerMemo.set(key, out); return out;
  };
  const distribution = Array<number>(7).fill(0);
  // Solo peeks under an Ace. A ten upcard retains the possibility of dealer blackjack.
  const norm = up === 1 ? 1 - P[10]! : 1;
  for (let hole = 1; hole <= 10; hole++) {
    const natural = up === 1 && hole === 10 || up === 10 && hole === 1;
    if (natural) { if (up !== 1) distribution[6]! += P[hole]!; continue; }
    dealer(up + hole, up === 1 || hole === 1).forEach((p, i) => { distribution[i]! += P[hole]! * p / norm; });
  }
  const stand = (value: number) => value > 21 ? -1 : distribution[5]! - distribution[6]! + distribution.slice(0, 5).reduce((s, p, i) => s + p * Math.sign(value - (17 + i)), 0);
  const memo = new Map<string, number>();
  const hitStand = (hard: number, ace: boolean): number => {
    if (hard > 21) return -1;
    const key = `${hard}:${ace}`, cached = memo.get(key); if (cached !== undefined) return cached;
    const value = best(hard, ace), st = stand(value);
    const hit = value >= 21 ? st : P.reduce((s, p, v) => v ? s + p * hitStand(hard + v, ace || v === 1) : s, 0);
    const out = Math.max(st, hit); memo.set(key, out); return out;
  };
  const double = (hard: number, ace: boolean) => 2 * P.reduce((s, p, v) => v ? s + p * stand(best(hard + v, ace || v === 1)) : s, 0);
  const splitValue = (value: number) => 2 * P.reduce((s, p, v) => {
    if (!v) return s;
    const h = value + v, a = value === 1 || v === 1;
    return s + p * (value === 1 ? stand(best(h, a)) : Math.max(hitStand(h, a), best(h, a) < 21 ? double(h, a) : -Infinity));
  }, 0);
  const ace = cards.some((c) => blackjackValue(c) === 1);
  let ev = hitStand(total.hard, ace);
  if (cards.length === 2) {
    ev = Math.max(ev, double(total.hard, ace));
    if (!split && blackjackValue(cards[0]!) === blackjackValue(cards[1]!)) ev = Math.max(ev, splitValue(blackjackValue(cards[0]!)));
  }
  const margins: Record<number, number> = { 1: .0279, 7: .02606, 8: .02686, 9: .0279, 10: .0279 };
  const raw = (1 + ev - (margins[up] ?? .02135)) * 100;
  return Math.max(0, legacy ? Math.round(raw) : Math.floor(raw));
}
