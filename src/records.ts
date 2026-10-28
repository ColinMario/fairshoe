import type { LoungeRoundProof } from './lounge.ts';
/**
 * The records a server publishes and a verifier checks (SPEC.md section 7): the proof of a round, and a shoe's
 * commitment and reveal. Plain JSON; times are milliseconds since 1970 (UTC).
 */
import type { TableRef } from './domains.ts';
import type { BurnRule, CardCode } from './shoe.ts';
import type { Draw } from './stream.ts';

/**
 * Who set a pair's client seed. 'player': sent by the player after the pair's hash and root were shown, so the server
 * seed was fixed before it. 'server': the player sent none before the first draw or shoe of the pair and the server
 * picked one; the server could then have tried client seeds until it liked the outcomes, so such records are not
 * provable against the operator (the verifiers say so).
 */
export type ClientSeedBy = 'player' | 'server';

/** Who may cut a shoe: 'player' (anywhere in the range, or automatically at kAuto) or 'auto' (only kAuto). */
export type CutPolicy = 'player' | 'auto';

/** One step of a game that drew from the round stream: it spent exactly one nonce. */
export interface StepProof {
  nonce: number;
  /** What the step was ('init', 'act', 'wake', 'abandon', 'round'). Informative only. */
  kind: string;
  /** 'ok' = the step was applied; 'discarded' = it drew and was then refused or failed (the nonce is spent anyway). */
  status: 'ok' | 'discarded';
  /** Every int(n) of the step in order. */
  draws: Draw[];
  /** Words read, rejected ones included. */
  words: number;
}

/** Cards [from, to) of a shoe's dealing order that went to a round, at table `table` of the game. */
export interface ShoeSlice {
  shoe: string;
  /** The table the round was played at (the shoe's commitment must name the same). */
  table: number;
  from: number;
  to: number;
}

/** The proof of one round (or of a step outside a round: roundId null). */
export interface RoundProof {
  /** Shared lounge proof: its own committed chain and independently verified public beacon. */
  lounge?: LoungeRoundProof;
  v: 1;
  alg: string;
  /** The library that produced it, `fairshoe@<version>`. */
  lib: string;
  /** Proof id (public reference). */
  id: string;
  /** Game id in the stream messages (a blackjack table id for blackjack). */
  gameId: string;
  /** The game's round id, null for a step that belongs to no round. */
  roundId: string | null;
  seedId: string;
  serverSeedHash: string;
  clientSeed: string;
  /** Who set the client seed of the pair (see ClientSeedBy): only 'player' is provable. */
  clientSeedBy: ClientSeedBy;
  /** The server seed once the pair is revealed (rotation), else null. */
  serverSeed: string | null;
  steps: StepProof[];
  /** Cards of committed shoes this round was dealt from; the shoes' own records prove their order. */
  shoes: ShoeSlice[];
  /** The game's summary of the round (cards, numbers, multipliers): what the draws mean. */
  outcome: unknown;
  engineVersion: number;
  at: number;
}

/** Where a shoe's order comes from: link `index` of a chain. */
export interface ShoeOrigin {
  kind: 'chain';
  /** The seed pair whose root binds the chain (its root lines and client seed are the ones to check against). */
  seedId: string;
  chainId: string;
  /** = shoeNo. */
  index: number;
  /** Link index - 1 (the terminal for shoe 1): never the shoe's own link, which would give away the order. */
  prevLink: string;
  /** Link 0 of the chain, bound in `root`. */
  terminal: string;
  /** Shoe root of the seed pair the chain belongs to (published before the client seed). */
  root: string;
}

/** Published before anybody can cut (event shoe_commit). */
export interface ShoeCommit {
  alg: string;
  shoe: string;
  gameId: string;
  table: TableRef;
  shoeNo: number;
  decks: number;
  origin: ShoeOrigin;
  clientSeed: string;
  /** Who set that client seed (the pair's ClientSeedBy): only 'player' is provable. */
  clientSeedBy: ClientSeedBy;
  shoeHash: string;
  /** Cuts allowed: [min, max] cards from the front. */
  cutRange: [number, number];
  /** Who may cut (the game's published rule, rules.ts). */
  cutPolicy: CutPolicy;
  autoCut: number;
  /** Index (in the dealing order) of the first card behind the cut card: the round dealing it is the shoe's last. Null: no cut card. */
  endAt: number | null;
  burnRule: BurnRule;
  /** Published guard rule; absent on historical shoes made before the guard was introduced. */
  guard?: 'rtp-995';
  guardWeights?: 'baccarat-multiplier/1';
  at: number;
}

export type ShoeEnd = 'ended' | 'shuffled' | 'aborted' | 'guarded';
export type CutBy = 'player' | 'auto' | 'timeout';

/** Published when the shoe is over (event shoe_reveal): everything needed to recompute it. */
export interface ShoeReveal {
  shoe: string;
  status: ShoeEnd;
  /** Exact visible-composition reason when this shoe ended by the published guard. */
  guard?: { before: number; spot: string; num: string; den: string };
  /** The chain link the shoe was shuffled under. */
  link: string;
  salt: string;
  /** O, one letter per card (LETTERS). */
  order: string;
  cut: { at: number; by: CutBy } | null;
  burn: { cards: number; shown: CardCode | null } | null;
  /** Every round dealt from the shoe, in order (free hands too, roundId null). */
  rounds: Array<{ roundId: string | null; from: number; to: number }>;
  at: number;
}

/** A shoe's commitment and, once it is over, its reveal. */
export interface ShoeRecord {
  commit: ShoeCommit;
  reveal: ShoeReveal | null;
}

/** A revealed seed pair. */
export interface SeedReveal {
  seedId: string;
  gameId: string;
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string | null;
  /** Who set the client seed, null while there is none (see ClientSeedBy). */
  clientSeedBy: ClientSeedBy | null;
  /** Nonces 0 ... lastNonce were used (-1: none). */
  lastNonce: number;
  /**
   * The last shoe number taken from each chain of the pair (0: none), one entry per root line. Final at the reveal:
   * no shoe of a revealed pair's chains is committed after it (SPEC.md section 5).
   */
  lastShoes: Array<{ table: number; shoeNo: number }>;
  root: { hash: string; lines: string[] } | null;
  committedAt: number;
  clientSeedAt: number | null;
  revealedAt: number;
}

/**
 * Everything on record for a pair, as the server lists it: the ids of all its round proofs (void ones and those of
 * steps outside a round included) and of all shoes of its chains (aborted ones included). A gap between listed records
 * shows; a record missing at the end shows only against the player's own records (verifyPair `own`).
 */
export interface PairRecords {
  seedId: string;
  gameId: string;
  proofs: string[];
  shoes: string[];
}
