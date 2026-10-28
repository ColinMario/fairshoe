/** Published lounge bot policy, version lounge-bots/1. Monetary choices never use presentation randomness. */
export const LOUNGE_TABLES = ['lounge-bali-1', 'lounge-amsterdam-1', 'lounge-deutsch-1', 'lounge-speed-1'] as const;
export const LOUNGE_BOT_NAMES = ['LuckyLuke', 'Mia_K', 'Jonas88', 'AceHunter', 'Elena.S', 'Ben_33', 'VelvetJack', 'Kaya21', 'Noah.B', 'LenaW', 'MaxPower', 'Sofia.R', 'Finn_7', 'GoldRush', 'JulesV', 'Anna_B', 'Countessa', 'Leon.H', 'Marlene21', 'Ricky.D', 'NinaBlue', 'Tobi_K', 'SilverFox', 'Clara.M', 'Emil88', 'Hanna_P', 'DoubleDown', 'Matteo.V', 'Ida_S', 'Paulchen'] as const;
export interface LoungeSeat {
    seat: number;
    id: string;
    name: string;
    bot: boolean;
    roundsLeft: number;
}
export interface LoungeBotState {
    seats: LoungeSeat[];
    target: number;
    targetRoundsLeft: number;
}
export interface LoungeBotBet {
    seat: number;
    spot: 'main' | 'pp' | 'p21' | 'behind';
    amount: number;
}
export interface LoungeBotPlan {
    state: LoungeBotState;
    left: string[];
    joined: LoungeSeat[];
    wagers: Array<{
        id: string;
        bets: LoungeBotBet[];
    }>;
    insurance: Array<{
        seat: number;
        normal: boolean;
        evenMoney: boolean;
    }>;
}
export function loungeTableRules(table: string) {
    if (!(LOUNGE_TABLES as readonly string[]).includes(table))
        throw new Error('unknown lounge table');
    return { minPlayers: table === 'lounge-amsterdam-1' || table === 'lounge-deutsch-1' ? 2 : 3,
        maxPlayers: table === 'lounge-amsterdam-1' || table === 'lounge-deutsch-1' ? 5 : 6,
        bettingMs: table === 'lounge-speed-1' ? 8000 : 15000, chips: [100, 200, 500, 2500, 5000, 10000, 25000, 50000] };
}
const nameHash = (name: string) => { let hash = 2166136261; for (let i = 0; i < name.length; i++)
    hash = Math.imul(hash ^ name.charCodeAt(i), 16777619); return hash >>> 0; };
/** The complete participation/bet/insurance plan is generated before the future beacon is known. */
export function planLoungeBots(table: string, before: LoungeBotState, rng: {
    int(n: number): number;
}, initial: boolean): LoungeBotPlan {
    const rules = loungeTableRules(table), state: LoungeBotState = JSON.parse(JSON.stringify(before));
    if (state.seats.length > 7 || new Set(state.seats.map(s => s.seat)).size !== state.seats.length || state.seats.some(s => !Number.isInteger(s.seat) || s.seat < 0 || s.seat > 6 || !s.id || !s.name || !Number.isSafeInteger(s.roundsLeft)))
        throw new Error('invalid opening bot state');
    const initialLeft = initial ? state.seats.filter(s => s.bot).map(s => s.id) : [];
    if (initial) {
        state.seats = state.seats.filter(s => !s.bot);
        state.target = 0;
        state.targetRoundsLeft = 0;
    }
    const chance = (n: number, d = 100) => rng.int(d) < n;
    const between = (lo: number, hi: number) => lo + rng.int(hi - lo + 1);
    const pick = <T>(items: readonly T[]): T => { if (!items.length)
        throw new Error('empty bot choice'); return items[rng.int(items.length)]!; };
    const players = () => new Set(state.seats.map(s => s.id)).size;
    const free = () => Array.from({ length: 7 }, (_, i) => i).filter(i => !state.seats.some(s => s.seat === i));
    const bots = () => state.seats.filter(s => s.bot);
    const plan: LoungeBotPlan = { state, left: initialLeft, joined: [], wagers: [], insurance: [] };
    if (state.targetRoundsLeft <= 0) {
        state.target = between(rules.minPlayers, rules.maxPlayers);
        state.targetRoundsLeft = between(4, 10);
    }
    state.targetRoundsLeft--;
    const leave = (bot: LoungeSeat) => { state.seats = state.seats.filter(s => s.id !== bot.id); plan.left.push(bot.id); };
    if (!initial) {
        const current = bots(), tired = current.filter(s => s.roundsLeft <= 0);
        if (free().length < 2 || players() > state.target) {
            const candidate = tired[0] ?? (current.length ? pick(current) : undefined);
            if (candidate)
                leave(candidate);
        }
        else if (tired.length && chance(60))
            leave(tired[0]!);
        if (free().length < 2 && bots().length)
            leave(pick(bots()));
    }
    const joins = initial ? 7 : chance(75) ? 1 : 0;
    for (let i = 0; i < joins && players() < state.target && free().length >= 3; i++) {
        const names = LOUNGE_BOT_NAMES.filter(n => !state.seats.some(s => s.name === n));
        if (!names.length)
            break;
        const name = pick(names);
        const bot = { seat: pick(free()), id: `bot:${name}`, name, bot: true, roundsLeft: between(6, 30) };
        state.seats.push(bot);
        plan.joined.push({ ...bot });
    }
    for (const bot of bots()) {
        const bets: LoungeBotBet[] = [];
        if (chance(87)) {
            const chips = rules.chips.filter(c => c <= 25000), style = nameHash(bot.name) % 3;
            const unit = chips[Math.min(chips.length - 1, style + (chance(25) ? 1 : 0))]!;
            bets.push({ seat: bot.seat, spot: 'main', amount: Math.min(100000, unit * pick([1, 1, 1, 2, 2, 3, 4, 5])) });
            if (chance(18))
                bets.push({ seat: bot.seat, spot: 'pp', amount: 100 * between(1, 2) });
            if (chance(18))
                bets.push({ seat: bot.seat, spot: 'p21', amount: 100 * between(1, 2) });
            if (chance(10)) {
                const others = state.seats.filter(s => s.id !== bot.id);
                if (others.length)
                    bets.push({ seat: pick(others).seat, spot: 'behind', amount: 100 * between(1, 3) });
            }
        }
        plan.wagers.push({ id: bot.id, bets });
        plan.insurance.push({ seat: bot.seat, normal: chance(5), evenMoney: chance(30) });
    }
    state.seats.sort((a, b) => a.seat - b.seat);
    return plan;
}
const HARD: Record<number, string> = { 9: 'HDDDDHHHHH', 10: 'DDDDDDDDHH', 11: 'DDDDDDDDDH', 12: 'HHSSSHHHHH', 13: 'SSSSSHHHHH', 14: 'SSSSSHHHHH', 15: 'SSSSSHHHHH', 16: 'SSSSSHHHHH' };
const SOFT: Record<number, string> = { 12: 'HHHHHHHHHH', 13: 'HHHDDHHHHH', 14: 'HHHDDHHHHH', 15: 'HHDDDHHHHH', 16: 'HHDDDHHHHH', 17: 'HDDDDHHHHH', 18: 'SXXXXSSHHH' };
const PAIR: Record<number, string> = { 1: 'PPPPPPPPPP', 2: 'PPPPPPHHHH', 3: 'PPPPPPHHHH', 4: 'HHHPPHHHHH', 6: 'PPPPPHHHHH', 7: 'PPPPPPHHHH', 8: 'PPPPPPPPPP', 9: 'PPPPPSPPSS' };
const value = (card: string) => card[0] === 'A' ? 1 : /^[1JQK]/.test(card) ? 10 : Number(card.slice(0, -1));
export function loungeBotAction(cards: readonly string[], up: string, legal: readonly string[]): string {
    const values = cards.map(value), hard = values.reduce((a, b) => a + b, 0), soft = values.includes(1) && hard + 10 <= 21, best = hard + (soft ? 10 : 0), column = value(up) === 1 ? 9 : value(up) - 2;
    if (legal.includes('split') && cards.length === 2 && values[0] === values[1] && PAIR[values[0]!]?.[column] === 'P')
        return 'split';
    const choice = soft ? (SOFT[best]?.[column] ?? 'S') : best >= 17 ? 'S' : HARD[best]?.[column] ?? 'H';
    const action = choice === 'D' ? (legal.includes('double') ? 'double' : 'hit') : choice === 'X' ? (legal.includes('double') ? 'double' : 'stand') : choice === 'H' ? 'hit' : 'stand';
    return legal.includes(action) ? action : 'stand';
}
