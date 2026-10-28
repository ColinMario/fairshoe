/**
 * Player-owned inputs for payout replay. Capture these before sending the corresponding wager/action and retain
 * only acknowledged actions. They must never be reconstructed later from the proof's outcome. `complete` is false
 * after reconnects, unknown replies, missing prior carry, or an action sent while an earlier wager is unacknowledged.
 */
export interface DrawAuthorization {
  kind: 'hilo-init' | 'hilo-exchange' | 'hilo-guess' | 'trading-trade' | 'blackjack-board' | 'baccarat-free' | 'baccarat-deal';
  /** Card actually displayed after the acknowledged Hi-Lo operation. */
  card?: string;
}
export interface ProofRef { seedId: string; roundId: string }
export interface GameplayState {
  trading?: { carry: number; value: number; staked: number };
  blackjack?: Record<string, null | { value: number; coversUpTo: number; category: string }>;
  hilo?: { card: string };
}
export interface GameplayBase { complete: boolean }

export interface HiloGameplay extends GameplayBase {
  kind: 'hilo/rounded-v1';
  /** Locked stake and face-up card, observed before PLAY. */
  stake: number;
  initialCard: string;
  /** Last paid round if its resulting card remains face-up; verified transitively, including across seed rotation. */
  cardFrom?: ProofRef;
  /** Next nonce independently tracked from own acknowledged operations; fair_get only cross-checks it. */
  startNonce: number;
  /** Acknowledged choices in order. Do not infer choices from which card won. */
  guesses: Array<'lo' | 'hi'>;
  ending: 'cashout' | 'lost' | 'target' | 'abandon';
  /** Auto target in hundredths, as set by this client before the final guess; null when off. */
  autoTarget: number | null;
  /** Acknowledged target changes during the round, taking effect before guesses[index]. */
  targetChanges?: Array<{ beforeGuess: number; value: number | null }>;
}

export interface TradingGameplay extends GameplayBase {
  kind: 'trading/carry99-v1';
  operation: 'trade' | 'cashout';
  /** Visible Portfolio state before TRADE/CASH OUT, including chips placed since the last trade. */
  value: number;
  chips: number;
  staked: number;
  side: 'up' | 'down';
  ride: boolean;
  startNonce: number;
  carry: number;
  /** True only for the initial 99 carry or the result of this client's previous independently checked cashout. */
  carryKnown: boolean;
  carryFrom?: ProofRef;
  portfolioFrom?: ProofRef;
  by?: 'player' | 'abandon';
}

export interface BlackjackWager {
  seat: number;
  main: number;
  pp: number;
  p21: number;
  behind?: Array<{ playerId: string; amount: number }>;
  pending: null | { value: number; coversUpTo: number; category: string };
}
export interface BlackjackChoice {
  seat: number;
  hand: number;
  action: 'hit' | 'stand' | 'double' | 'split' | 'surrender' | 'cashout';
  /** Number of cards observed in the round before this acknowledged choice (including the dealer's hole position). */
  at: number;
}
export interface BlackjackGameplay extends GameplayBase {
  kind: 'blackjack/payout-v1';
  /** Published immutable rule version known before DEAL, not a rule object supplied by the final outcome. */
  rules: 'solo/g7' | 'free-double/g7' | 'multiplier/set-a-r1' | 'solo/legacy' | 'multiplier/legacy' | 'lounge/g1';
  boxes: BlackjackWager[];
  startNonce: number;
  actions: BlackjackChoice[];
  insurance: Array<{ seat: number; take: boolean; evenMoney?: boolean }>;
  /** Pending multipliers are anchored to this client's earlier verified round, or absent at a fresh table. */
  carryKnown: boolean;
  carryFrom?: Record<string, ProofRef>;
  /** Unplayed seats whose zero carry was kept from this client's own fresh-table timeline. */
  initialSeats?: number[];
}

export type GameplayWitness = HiloGameplay | TradingGameplay | BlackjackGameplay;
