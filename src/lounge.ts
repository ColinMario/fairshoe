/** Shared lounge commitments and independent verification. Other humans' existence is never proven. */
import { fromHex, toHex, utf8 } from './bytes.ts';
import { sha256 } from './sha256.ts';
import { linkReaches } from './chain.ts';
import { buildOrder, shuffleInPlace } from './shoe.ts';
import { HmacStream, uniformInt } from './stream.ts';
import { quicknetRoundAfter, quicknetRoundTime, verifyQuicknetBeacon, type QuicknetBeacon } from './quicknet.ts';
import { loungeBotAction, loungeTableRules, planLoungeBots, type LoungeBotPlan, type LoungeBotState } from './lounge-bots.ts';
import { replayBlackjack, type BlackjackReplay } from './blackjack-payout.ts';
import type { BlackjackChoice, BlackjackWager } from './gameplay.ts';
export * from './lounge-bots.ts';
export const LOUNGE_POLICY = 'lounge-bots/1';
export const LOUNGE_BEACON_LEAD_MS = 3000;
export interface LoungeSeed {
    id: string;
    seed: string;
    by: 'player' | 'server';
}
export interface LoungeRoot {
    chainId: string;
    tableId: string;
    terminal: string;
    length: number;
}
export interface LoungeRoundCommit extends LoungeRoot {
    id: string;
    index: number;
    previous: string;
    openedAt: number;
    openingSeeds: LoungeSeed[];
    beforeBots: LoungeBotState;
    initial: boolean;
    botPlanHash: string;
}
export interface LoungeBox extends BlackjackWager {
    ownerId: string;
    bot: boolean;
}
export interface LoungeRoundLock {
    commitId: string;
    roundId: string;
    closedAt: number;
    deadline: number;
    reason: 'timer' | 'ready';
    ready: string[];
    seeds: LoungeSeed[];
    boxes: LoungeBox[];
    plan: LoungeBotPlan;
    beaconRound: number;
    hash: string;
}
export interface LoungeRoundProof {
    v: 1;
    policy: typeof LOUNGE_POLICY;
    commit: LoungeRoundCommit;
    lock: LoungeRoundLock;
    link: string;
    beacon: QuicknetBeacon | null;
    cards: string[];
    actions: Array<BlackjackChoice & {
        auto?: boolean;
        atMs?: number;
        deadline?: number | null;
        reason?: 'timeout' | 'absent';
    }>;
    insurance: Array<{
        seat: number;
        take: boolean;
        auto?: boolean;
    }>;
    ledger: Record<string, {
        staked: number;
        returned: number;
    }>;
    hands: Array<{
        seat: number;
        hand: number;
        outcome: string;
        bet: number;
        payout: number;
    }>;
    status: 'ok' | 'void';
    at: number;
    voidReason?: string;
    demo?: boolean;
    /** Rejected state-changing requests after wagers were locked; no card entropy is redrawn. */
    discarded?: number;
}
export interface LoungeOwnRecords {
    root: LoungeRoot;
    rootReceivedAt: number;
    seed: string;
    seedSentAt: number;
    playerId: string;
    commit: LoungeRoundCommit;
    commitReceivedAt: number;
    lock: LoungeRoundLock;
    lockReceivedAt: number;
    /** The exact board this player accepted at the close, including Bet Behind shares. */
    bets: Array<{
        seat: number;
        spot: 'main' | 'pp' | 'p21' | 'behind';
        amount: number;
    }>;
    ready: boolean;
    deadline?: number;
    betsComplete?: boolean;
    discarded?: number;
    left?: boolean;
    /** Earlier public proofs of this chain, keyed independently by the client, never recursively copied into them. */
    prior?: LoungeRoundProof[];
    turns?: Array<{
        seat: number;
        hand: number;
        at: number;
        endsAt: number | null;
    }>;
    cards?: readonly (string | null)[];
    actions?: BlackjackChoice[];
    places?: Array<'dealer' | {
        seat: number;
        hand: number;
    }>;
    observedActions?: Array<BlackjackChoice & {
        auto: boolean;
    }>;
    insurance?: Array<{
        seat: number;
        take: boolean;
    }>;
    complete?: boolean;
}
export interface LoungeCheck {
    ok: boolean;
    provable: boolean;
    errors: string[];
    unproven: string[];
    cards: string[] | null;
    outcome: {
        checked: boolean;
        errors: string[];
    };
}
/** Canonical JSON: keys sorted recursively, arrays in their published order, no nonfinite numbers or omitted values. */
export function loungeCanonical(value: unknown): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return JSON.stringify(value);
    if (typeof value === 'number' && Number.isSafeInteger(value))
        return String(value);
    if (Array.isArray(value))
        return `[${value.map(loungeCanonical).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${loungeCanonical(v)}`).join(',')}}`;
    throw new Error('invalid canonical lounge value');
}
export const loungeHash = (value: unknown) => toHex(sha256(utf8(loungeCanonical(value))));
export const loungeSeeds = (seeds: readonly LoungeSeed[]) => [...seeds].map(s => ({ ...s })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export function loungeBotRng(link: string, tableId: string, openingSeeds: readonly LoungeSeed[], index: number) {
    const clientSeed = loungeHash(loungeSeeds(openingSeeds));
    const stream = new HmacStream(fromHex(link), b => `fairshoe/v1/bots:${tableId}:${clientSeed}:${index}:${b}`);
    return { int: (n: number) => uniformInt(stream, n) };
}
export function loungeLockHash(lock: Omit<LoungeRoundLock, 'hash'> | LoungeRoundLock): string { const { hash: _hash, ...plain } = lock as LoungeRoundLock; return loungeHash(plain); }
export function loungeCards(link: string, lock: LoungeRoundLock, beacon: QuicknetBeacon): string[] {
    const stream = new HmacStream(fromHex(link), b => `fairshoe/v1/lounge-shoe:${lock.hash}:${beacon.randomness}:${b}`);
    const cards = shuffleInPlace(buildOrder(8), { int: (n: number) => uniformInt(stream, n) });
    const cutStream = new HmacStream(sha256(utf8(lock.hash)), b => `fairshoe/v1/lounge-cut:${lock.commitId}:${b}`);
    const cut = 52 + uniformInt(cutStream, 313);
    return [...cards.slice(cut), ...cards.slice(0, cut)];
}
export function loungeLedger(boxes: readonly LoungeBox[], replay: BlackjackReplay): LoungeRoundProof['ledger'] {
    const ledger: LoungeRoundProof['ledger'] = Object.create(null) as LoungeRoundProof['ledger'];
    const add = (id: string, staked: number, returned: number) => { const row = ledger[id] ??= { staked: 0, returned: 0 }; row.staked += staked; row.returned += returned; };
    for (const box of replay.boxes) {
        const owner = boxes.find(b => b.seat === box.seat);
        if (!owner)
            throw new Error('missing owner');
        add(owner.ownerId, box.staked, box.returned);
        for (const b of box.behind)
            add(b.playerId, b.amount, b.payout);
    }
    return ledger;
}
const same = (a: unknown, b: unknown) => loungeCanonical(a) === loungeCanonical(b);
const positive = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
function verifyBotBets(lock: LoungeRoundLock): void {
    for (const wager of lock.plan.wagers) {
        const seat = lock.plan.state.seats.find(s => s.id === wager.id)!;
        const boxes = lock.boxes.filter(b => b.ownerId === wager.id);
        if (boxes.length > 1)
            throw new Error('bot entered multiple boxes outside its committed seat');
        const box = boxes[0];
        const main = wager.bets.find(b => b.spot === 'main');
        if (!main && box)
            throw new Error('bot entered without its committed bet');
        if (main && (!box || !box.bot || box.seat !== seat.seat || box.main !== main.amount || box.pp !== (wager.bets.find(b => b.spot === 'pp')?.amount ?? 0) || box.p21 !== (wager.bets.find(b => b.spot === 'p21')?.amount ?? 0)))
            throw new Error('bot wagers differ from the committed plan');
        const behind = wager.bets.find(b => b.spot === 'behind');
        for (const target of lock.boxes) {
            const actual = target.behind?.filter(b => b.playerId === wager.id).reduce((sum, b) => sum + b.amount, 0) ?? 0;
            const initialTarget = lock.plan.state.seats.find(s => s.seat === target.seat);
            const expected = behind?.seat === target.seat && initialTarget?.id === target.ownerId ? behind.amount : 0;
            if (actual !== expected)
                throw new Error('bot Bet Behind differs from the committed plan');
        }
    }
    for (const box of lock.boxes)
        if (box.bot && !lock.plan.wagers.some(w => w.id === box.ownerId))
            throw new Error('unplanned bot in the round');
}
export function verifyLoungeRound(proof: LoungeRoundProof, own?: LoungeOwnRecords): LoungeCheck {
    const errors: string[] = [], unproven: string[] = [];
    let cards: string[] | null = null;
    let checked = false;
    try {
        if (!Number.isSafeInteger(proof.discarded ?? 0) || (proof.discarded ?? 0) < 0)
            throw new Error('invalid discarded-step count');
        if (own?.discarded !== undefined && (proof.discarded ?? 0) < own.discarded)
            throw new Error('the proof omits rejected steps observed by the player');
        if (proof.demo)
            unproven.push('local demo: player and server are the same device');
        if (proof.v !== 1 || proof.policy !== LOUNGE_POLICY)
            throw new Error('unknown lounge proof policy');
        const { commit, lock, beacon } = proof;
        loungeTableRules(commit.tableId);
        if (commit.chainId !== `lounge-${commit.tableId}-${commit.terminal.slice(0, 24)}` || commit.id !== `${commit.chainId}-${commit.index}`)
            throw new Error('invalid lounge commitment identity');
        if (!positive(commit.length) || commit.length > 2000 || !positive(commit.index) || commit.index > commit.length || !Number.isSafeInteger(commit.openedAt))
            throw new Error('invalid lounge chain coordinates');
        if (!/^[0-9a-f]{64}$/.test(proof.link) || !linkReaches(fromHex(proof.link), 1, commit.previous) || !linkReaches(fromHex(proof.link), commit.index, commit.terminal))
            throw new Error('lounge link is not on the committed chain');
        if (lock.commitId !== commit.id || lock.hash !== loungeLockHash(lock) || lock.closedAt < commit.openedAt || lock.deadline < commit.openedAt)
            throw new Error('invalid locked round');
        if (lock.deadline < commit.openedAt + loungeTableRules(commit.tableId).bettingMs)
            throw new Error('the published betting interval was shortened');
        if (lock.reason === 'ready' && !lock.boxes.some(b => !b.bot))
            throw new Error('early close needs at least one human ready vote');
        if (lock.reason === 'timer' && lock.closedAt < lock.deadline)
            throw new Error('betting closed before its published deadline');
        if (lock.reason !== 'timer' && lock.reason !== 'ready')
            throw new Error('invalid betting-close trigger');
        if (lock.beaconRound !== quicknetRoundAfter(lock.closedAt + LOUNGE_BEACON_LEAD_MS) || (beacon !== null && (beacon.round !== lock.beaconRound || !verifyQuicknetBeacon(beacon))))
            throw new Error('beacon differs from the fixed future round or has an invalid signature');
        for (const seeds of [commit.openingSeeds, lock.seeds])
            if (seeds.length > 64 || !same(seeds, loungeSeeds(seeds)) || new Set(seeds.map(s => s.id)).size !== seeds.length || seeds.some(s => !s.id || !/^[A-Za-z0-9_-]{1,64}$/.test(s.seed) || (s.by !== 'player' && s.by !== 'server')))
                throw new Error('invalid participant seeds');
        const plan = planLoungeBots(commit.tableId, commit.beforeBots, loungeBotRng(proof.link, commit.tableId, commit.openingSeeds, commit.index), commit.initial);
        if (loungeHash(plan) !== commit.botPlanHash || !same(plan, lock.plan))
            throw new Error('bot plan does not match its committed stream');
        if (lock.boxes.length > 7 || lock.boxes.some(b => !b.ownerId || !positive(b.main) || b.main > 100000 || b.main < 100 || b.pp > 20000 || b.p21 > 20000))
            throw new Error('invalid lounge bets');
        for (const box of lock.boxes) {
            if (box.bot !== box.ownerId.startsWith('bot:') || [box.pp, box.p21].some(n => !Number.isSafeInteger(n) || n < 0 || (n > 0 && n < 100)))
                throw new Error('invalid lounge owner or side bet');
            if (new Set((box.behind ?? []).map(b => b.playerId)).size !== (box.behind ?? []).length || (box.behind ?? []).some(b => !b.playerId || b.playerId === box.ownerId || !positive(b.amount) || b.amount < 100 || b.amount > 50000))
                throw new Error('invalid Bet Behind stake');
            for (const b of box.behind ?? [])
                if (b.playerId.startsWith('bot:') && !lock.plan.wagers.some(w => w.id === b.playerId))
                    throw new Error('unplanned bot Bet Behind');
            if (!box.bot && lock.boxes.filter(b => b.ownerId === box.ownerId).length > 4)
                throw new Error('human seat limit exceeded');
        }
        verifyBotBets(lock);
        const owners = new Set(lock.boxes.filter(b => !b.bot).map(b => b.ownerId));
        for (const box of lock.boxes)
            for (const b of box.behind ?? [])
                if (!b.playerId.startsWith('bot:'))
                    owners.add(b.playerId);
        if (owners.size !== lock.seeds.length || [...owners].some(id => !lock.seeds.some(s => s.id === id)))
            throw new Error('a human wager lacks its frozen client seed');
        if (lock.reason === 'ready' && lock.boxes.filter(b => !b.bot).some(b => !lock.ready.includes(b.ownerId)))
            throw new Error('early close lacks every seated human ready vote');
        if (proof.status === 'void')
            return { ok: true, provable: false, errors: [], unproven: [`locked lounge round voided: ${proof.voidReason ?? 'unavailable runtime'}`], cards: null, outcome: { checked: false, errors: [] } };
        if (proof.status !== 'ok' || !beacon)
            throw new Error('a completed lounge round needs its verified beacon');
        if (commit.index === 1 && !commit.initial)
            throw new Error('a new lounge chain must reset its bot lifecycle');
        if (own && commit.index > 1) {
            const prior = (own.prior ?? []).filter(p => p.commit.chainId === commit.chainId).sort((a, b) => a.commit.index - b.commit.index);
            if (prior.length !== commit.index - 1 || prior.some((p, i) => p.commit.index !== i + 1))
                unproven.push('earlier lounge proofs needed to verify bot lifecycle continuity are missing');
            else {
                for (let i = 0; i < prior.length; i++) {
                    const previous = prior[i]!, current = i + 1 < prior.length ? prior[i + 1]! : proof;
                    if (!verifyLoungeRound(previous).ok)
                        throw new Error('a predecessor lounge proof is invalid');
                    if (current.commit.openedAt < previous.at)
                        throw new Error('bot lifecycle advanced before the previous round ended');
                    if (previous.status === 'void') {
                        if (!current.commit.initial)
                            throw new Error('bot lifecycle must reset after a void');
                        continue;
                    }
                    if (current.commit.initial)
                        throw new Error('bot lifecycle was reset without a chain renewal or void');
                    const expected = previous.lock.plan.state.seats.filter(s => s.bot).map(s => ({ ...s, roundsLeft: s.roundsLeft - (previous.lock.boxes.some(b => b.ownerId === s.id) ? 1 : 0) }));
                    const actual = current.commit.beforeBots.seats.filter(s => s.bot);
                    if (!same(expected, actual) || current.commit.beforeBots.target !== previous.lock.plan.state.target || current.commit.beforeBots.targetRoundsLeft !== previous.lock.plan.state.targetRoundsLeft)
                        throw new Error('bot lifecycle state differs from the prior committed round');
                }
            }
        }
        cards = loungeCards(proof.link, lock, beacon);
        if (proof.cards.length > 416 || proof.cards.some((c, i) => c !== cards![i]))
            throw new Error('dealt cards differ from the committed future-beacon shoe');
        const replay = replayBlackjack({ rules: 'lounge/g1', boxes: lock.boxes, cards: proof.cards, actions: proof.actions, insurance: proof.insurance });
        for (let i = 0; i < replay.decisions.length; i++) {
            const d = replay.decisions[i]!, box = lock.boxes.find(b => b.seat === d.seat)!;
            if (box.bot && proof.actions[i]?.action !== loungeBotAction(d.cards, d.up, d.legal))
                throw new Error('bot departed from the published basic strategy');
            const action = proof.actions[i]!;
            if (!box.bot && action.auto) {
                let hard = 0, aces = 0;
                for (const card of d.cards) {
                    const rank = card.slice(0, -1);
                    hard += rank === 'A' ? 1 : /^(10|J|Q|K)$/.test(rank) ? 10 : Number(rank);
                    if (rank === 'A')
                        aces++;
                }
                const best = hard + (aces && hard + 10 <= 21 ? 10 : 0);
                if (action.action !== (best <= 11 && d.legal.includes('hit') ? 'hit' : 'stand'))
                    throw new Error('human auto action differs from the published timeout policy');
                if (action.reason === 'timeout' && (!Number.isSafeInteger(action.atMs) || !Number.isSafeInteger(action.deadline) || action.atMs! < action.deadline!))
                    throw new Error('human timeout ran before its published deadline');
                if (action.reason !== 'timeout' && action.reason !== 'absent')
                    throw new Error('human auto action has no published reason');
                if (own && box.ownerId === own.playerId && action.reason === 'absent' && own.complete && !own.left)
                    throw new Error('the player never left before the absent-player action');
                if (own && box.ownerId === own.playerId && action.reason === 'timeout') {
                    const turn = own.complete ? own.turns?.find(t => t.seat === d.seat && t.hand === d.hand && t.at === d.at) : undefined;
                    if (!turn)
                        unproven.push('the player did not retain this timeout deadline');
                    else if (turn.endsAt !== action.deadline)
                        throw new Error('the timeout deadline differs from the player observed turn');
                }
            }
        }
        if (proof.insurance.some(i => i.auto && i.take))
            throw new Error('automatic insurance must be declined');
        for (const offer of replay.insuranceOffers) {
            const box = lock.boxes.find(b => b.seat === offer.seat)!;
            if (!box.bot)
                continue;
            const coin = plan.insurance.find(i => i.seat === offer.seat)!;
            if ((proof.insurance.find(i => i.seat === offer.seat)?.take ?? false) !== (offer.evenMoney ? coin.evenMoney : coin.normal))
                throw new Error('bot insurance differs from its pre-beacon coin');
        }
        if (!same(proof.ledger, loungeLedger(lock.boxes, replay)))
            throw new Error('lounge ledger or Bet Behind payout differs from replay');
        const hands = replay.boxes.flatMap(b => b.hands.map(h => ({ seat: h.seat, hand: h.hand, outcome: h.outcome, bet: h.bet, payout: h.payout })));
        if (!same(proof.hands, hands))
            throw new Error('lounge hand results differ from replay');
        if (proof.status !== 'ok')
            unproven.push('the locked lounge round was voided');
        checked = true;
        if (!own)
            unproven.push('the player commitment, seed and locked wager records are not given');
        else {
            const root = { chainId: commit.chainId, tableId: commit.tableId, terminal: commit.terminal, length: commit.length };
            if (!same(root, own.root) || !same(commit, own.commit) || !same(lock, own.lock))
                throw new Error('lounge commitment or locked round differs from the player records');
            if (!(own.rootReceivedAt < own.seedSentAt && own.seedSentAt <= own.lockReceivedAt && own.commitReceivedAt <= own.lockReceivedAt && own.lockReceivedAt < quicknetRoundTime(beacon.round)))
                unproven.push('the root/seed/lock was not kept in time before the beacon became public');
            if (own.deadline === undefined)
                unproven.push('the player did not retain the published betting deadline');
            else if (own.deadline !== lock.deadline)
                throw new Error('the locked betting deadline differs from the player observed deadline');
            const seed = lock.seeds.find(s => s.id === own.playerId);
            if (!seed || seed.by !== 'player' || seed.seed !== own.seed)
                unproven.push('the player seed is not included in the locked participant set');
            if (own.betsComplete !== false && lock.reason === 'ready' && lock.boxes.some(b => b.ownerId === own.playerId) && !own.ready)
                throw new Error('the player never requested this early close');
            const bets: LoungeOwnRecords['bets'] = [];
            for (const b of lock.boxes) {
                if (b.ownerId === own.playerId) {
                    for (const spot of ['main', 'pp', 'p21'] as const)
                        if (b[spot])
                            bets.push({ seat: b.seat, spot, amount: b[spot] });
                }
                for (const x of b.behind ?? [])
                    if (x.playerId === own.playerId)
                        bets.push({ seat: b.seat, spot: 'behind', amount: x.amount });
            }
            const sort = (list: LoungeOwnRecords['bets']) => [...list].sort((a, b) => a.seat - b.seat || a.spot.localeCompare(b.spot));
            if (own.betsComplete === false)
                unproven.push('the player wager/ready witness is incomplete');
            else if (!same(sort(own.bets), sort(bets)))
                throw new Error('the locked bets differ from the player approved board');
            // Missing events lose positional alignment; partial arrays cannot contradict a complete server trace.
            if (!own.complete)
                unproven.push('the observed lounge card/action transcript is incomplete');
            else {
                if (!own.places)
                    unproven.push('the observed destinations of the lounge cards are not supplied');
                else if (!same(own.places, replay.places))
                    throw new Error('the card destinations differ from the observed table');
                if (!own.observedActions)
                    unproven.push('the observed lounge action transcript is not supplied');
                else if (!same(own.observedActions, proof.actions.map(a => ({ seat: a.seat, hand: a.hand, action: a.action, at: a.at, auto: a.auto === true }))))
                    throw new Error('the lounge actions differ from the observed table');
                if (!own.cards)
                    unproven.push('the cards observed by this player are not supplied');
                else if (own.cards.some((c, i) => c === null && i !== 2 * lock.boxes.length + 1))
                    throw new Error('a visible card is missing from the player record');
                else if (own.cards.length !== proof.cards.length || own.cards.some((c, i) => c !== null && c !== proof.cards[i]))
                    throw new Error('the cards observed by the player differ from the proof');
            }
            if (!own.complete || !own.actions || !own.insurance)
                unproven.push('the player action witness is incomplete');
            else {
                const seats = new Set(lock.boxes.filter(b => b.ownerId === own.playerId).map(b => b.seat));
                const actions = proof.actions.filter(a => seats.has(a.seat) && !a.auto).map(({ auto: _auto, atMs: _atMs, deadline: _deadline, reason: _reason, ...a }) => a);
                if (!same(actions, own.actions))
                    throw new Error('the player actions differ from the acknowledged choices');
                const insurance = proof.insurance.filter(a => seats.has(a.seat) && !a.auto).map(({ auto: _auto, ...choice }) => choice);
                if (!same(insurance, own.insurance))
                    throw new Error('the player insurance differs from the acknowledged choices');
            }

        }
    }
    catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
    }
    return { ok: errors.length === 0, provable: errors.length === 0 && unproven.length === 0, errors, unproven, cards, outcome: { checked, errors: errors.length ? errors : [] } };
}
