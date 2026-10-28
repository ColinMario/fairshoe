/**
 * Names, versions and the HMAC messages of fairshoe/v1 (SPEC.md section 3). Every use of a key has its own prefix,
 * so no two purposes can ever produce the same message: round stream, shoe stream, shoe salt, automatic cut, bots.
 */

/** Algorithm id; part of every record. */
export const ALG = 'fairshoe/v1';
/** This library (records name it as `fairshoe@<version>`). */
export const LIB_VERSION = '1.2.0';
export const LIB = `fairshoe@${LIB_VERSION}`;

/** Game ids: lower-case letters, digits, '_' and '-', 1 to 64 characters, never ':' (the id is part of every message). */
const GAME_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Client seeds: 1 to 64 characters of [A-Za-z0-9_-], so ':' and ',' are safe separators. */
const CLIENT_SEED = /^[A-Za-z0-9_-]{1,64}$/;

export function isGameId(value: unknown): value is string {
  return typeof value === 'string' && GAME_ID.test(value);
}

export function isClientSeed(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_SEED.test(value);
}

/**
 * A table: its number at the game (1, 2, ...; one table = 1). Only numbers in v1: a table id written as text would
 * give the same message as the number ("1" and 1), so shared lounge tables will get a domain of their own.
 */
export type TableRef = number;

export function isTableRef(value: unknown): value is TableRef {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** A nonce, a shoe number or a block index. */
export function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`fairshoe: bad ${what}`);
}

/** The HMAC messages (UTF-8). */
export const message = {
  /** Round stream, key = server seed: every draw of a game step. */
  stream(gameId: string, clientSeed: string, nonce: number, block: number): string {
    return `${ALG}/stream:${gameId}:${clientSeed}:${nonce}:${block}`;
  },
  /** Shoe stream, key = chain link `shoeNo`: the shuffle of that shoe and nothing else. */
  shoe(gameId: string, table: TableRef, clientSeed: string, shoeNo: number, block: number): string {
    return `${ALG}/shoe:${gameId}:${table}:${clientSeed}:${shoeNo}:${block}`;
  },
  /** Salt of the shoe commitment, key = chain link `shoeNo` (one HMAC, 32 bytes). */
  salt(gameId: string, table: TableRef, clientSeed: string, shoeNo: number): string {
    return `${ALG}/salt:${gameId}:${table}:${clientSeed}:${shoeNo}`;
  },
  /** Automatic cut, key = UTF-8 of the client seed: known before the shuffle, independent of the order. */
  cutAuto(gameId: string, table: TableRef, shoeNo: number, block: number): string {
    return `${ALG}/cut-auto:${gameId}:${table}:${shoeNo}:${block}`;
  },
  /** Lounge bots (reserved for shared tables), key = chain link `shoeNo`. */
  bots(table: TableRef, clientSeed: string, shoeNo: number, block: number): string {
    return `${ALG}/bots:${table}:${clientSeed}:${shoeNo}:${block}`;
  },
};

/** Throws when an input of a message is outside its character set (a ':' would make messages ambiguous). */
export function checkInputs(inputs: { gameId?: unknown; clientSeed?: unknown; table?: unknown; counter?: unknown }): void {
  if ('gameId' in inputs) check(isGameId(inputs.gameId), 'game id');
  if ('clientSeed' in inputs) check(isClientSeed(inputs.clientSeed), 'client seed');
  if ('table' in inputs) check(isTableRef(inputs.table), 'table');
  if ('counter' in inputs) check(isCounter(inputs.counter), 'nonce or shoe number');
}
