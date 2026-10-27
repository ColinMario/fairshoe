/**
 * describe, it and expect on node:test, with the matchers these tests use and vitest's meaning for them: toEqual
 * compares deeply and ignores properties that are undefined, toMatchObject matches a subset (arrays element by element,
 * of the same length), toMatch with a string looks for it, toContain compares with ===, expect.stringMatching matches
 * inside toEqual and toMatchObject. `npm test` runs the tests with it: nothing to install.
 */
import { AssertionError } from 'node:assert';
import { describe as nodeDescribe, it as nodeIt } from 'node:test';
import { inspect } from 'node:util';

export interface Matchers {
  readonly not: Matchers;
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toMatchObject(expected: object): void;
  toMatch(expected: RegExp | string): void;
  toContain(expected: unknown): void;
  toThrow(expected?: RegExp | string | (abstract new (...args: never[]) => unknown)): void;
  toBeLessThan(expected: number | bigint): void;
  toBeGreaterThan(expected: number | bigint): void;
  toHaveLength(expected: number): void;
  toBeUndefined(): void;
  toBeNull(): void;
}

export interface Expect {
  (actual: unknown, message?: string): Matchers;
  /** Inside toEqual and toMatchObject: any string that matches (a string is read as a regular expression). */
  stringMatching(expected: RegExp | string): unknown;
}

export interface It {
  (name: string, fn: () => unknown): void;
  /** One test per row; `%i`, `%d`, `%s`, `%j`, `%o` in the name take the row's values in turn. */
  each<T extends readonly unknown[]>(rows: readonly T[]): (name: string, fn: (...args: [...T]) => unknown) => void;
}

export interface Api {
  describe(name: string, fn: () => void): void;
  it: It;
  expect: Expect;
}

export function describe(name: string, fn: () => void): void {
  void nodeDescribe(name, () => {
    fn();
  });
}

function formatName(name: string, args: readonly unknown[]): string {
  let i = 0;
  return name.replace(/%[sdifjo%]/g, (m) => {
    if (m === '%%') return '%';
    if (i >= args.length) return m;
    const v = args[i++];
    if (m === '%i') return String(Math.trunc(Number(v)));
    if (m === '%d' || m === '%f') return String(Number(v));
    if (m === '%j') return JSON.stringify(v);
    return typeof v === 'string' ? v : inspect(v, { depth: 1 });
  });
}

export const it: It = Object.assign(
  (name: string, fn: () => unknown): void => {
    void nodeIt(name, async () => {
      await fn();
    });
  },
  {
    each<T extends readonly unknown[]>(rows: readonly T[]) {
      return (name: string, fn: (...args: [...T]) => unknown): void => {
        for (const row of rows) it(formatName(name, row), () => fn(...(row as [...T])));
      };
    },
  },
);

// ------------------------------------------------------------------------------------------------ equality

const ASYMMETRIC = Symbol('asymmetric matcher');

interface Asymmetric {
  [ASYMMETRIC]: (actual: unknown) => boolean;
  toString(): string;
}

function isAsymmetric(v: unknown): v is Asymmetric {
  return typeof v === 'object' && v !== null && typeof (v as Partial<Asymmetric>)[ASYMMETRIC] === 'function';
}

const tagOf = (v: unknown): string => Object.prototype.toString.call(v);

/**
 * Deep equality of `actual` with `expected` (which may hold asymmetric matchers). `subset`: every key of an expected
 * object must be there and match, other keys of the actual object do not matter (toMatchObject). Otherwise the
 * defined keys must be the same on both sides (toEqual: a key whose value is undefined counts as missing).
 */
function equals(actual: unknown, expected: unknown, subset: boolean): boolean {
  if (isAsymmetric(expected)) return expected[ASYMMETRIC](actual);
  if (Object.is(actual, expected)) return true;
  if (typeof actual !== 'object' || typeof expected !== 'object' || actual === null || expected === null) return false;
  if (tagOf(actual) !== tagOf(expected)) return false;
  if (actual instanceof Date) return actual.getTime() === (expected as Date).getTime();
  if (actual instanceof RegExp) return String(actual) === String(expected);
  if (ArrayBuffer.isView(actual)) {
    const a = actual as unknown as ArrayLike<unknown>;
    const b = expected as unknown as ArrayLike<unknown>;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(actual)) {
    const b = expected as unknown[];
    if (actual.length !== b.length) return false;
    for (let i = 0; i < actual.length; i++) if (!equals(actual[i], b[i], subset)) return false;
    return true;
  }
  if (actual instanceof Set) {
    const b = expected as Set<unknown>;
    if (actual.size !== b.size) return false;
    for (const x of b) if (![...actual].some((y) => equals(y, x, subset))) return false;
    return true;
  }
  if (actual instanceof Map) {
    const b = expected as Map<unknown, unknown>;
    if (actual.size !== b.size) return false;
    for (const [k, x] of b) if (!actual.has(k) || !equals(actual.get(k), x, subset)) return false;
    return true;
  }
  const a = actual as Record<string, unknown>;
  const b = expected as Record<string, unknown>;
  if (subset) return Object.keys(b).every((k) => k in a && equals(a[k], b[k], true));
  const defined = (o: Record<string, unknown>): string[] => Object.keys(o).filter((k) => o[k] !== undefined);
  const ka = defined(a);
  const kb = defined(b);
  return ka.length === kb.length && kb.every((k) => Object.prototype.hasOwnProperty.call(a, k) && equals(a[k], b[k], false));
}

// ------------------------------------------------------------------------------------------------ expect

const show = (v: unknown): string => (isAsymmetric(v) ? v.toString() : inspect(v, { depth: 8, maxArrayLength: 50, maxStringLength: 400, breakLength: 120 }));

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function matchers(actual: unknown, label: string | undefined, negated: boolean): Matchers {
  /** Fails unless `pass` (or, under .not, unless it does not pass). */
  const check = (pass: boolean, operator: string, what: string, expected?: unknown): void => {
    if (pass !== negated) return;
    const head = label ? `${label}: ` : '';
    const message = `${head}expected ${show(actual)} ${negated ? 'not ' : ''}${what}`;
    throw new AssertionError({ message, actual, expected, operator });
  };
  const self: Matchers = {
    get not(): Matchers {
      return matchers(actual, label, !negated);
    },
    toBe(expected) {
      check(Object.is(actual, expected), 'toBe', `to be ${show(expected)}`, expected);
    },
    toEqual(expected) {
      check(equals(actual, expected, false), 'toEqual', `to equal ${show(expected)}`, expected);
    },
    toMatchObject(expected) {
      if (typeof actual !== 'object' || actual === null) throw new AssertionError({ message: `${label ? `${label}: ` : ''}toMatchObject needs an object, got ${show(actual)}` });
      check(equals(actual, expected, true), 'toMatchObject', `to match the object ${show(expected)}`, expected);
    },
    toMatch(expected) {
      if (typeof actual !== 'string') throw new AssertionError({ message: `${label ? `${label}: ` : ''}toMatch needs a string, got ${show(actual)}` });
      const pass = typeof expected === 'string' ? actual.includes(expected) : new RegExp(expected).test(actual);
      check(pass, 'toMatch', `to match ${show(expected)}`, expected);
    },
    toContain(expected) {
      let pass: boolean;
      if (typeof actual === 'string') pass = typeof expected === 'string' && actual.includes(expected);
      else if (actual !== null && typeof actual === 'object' && Symbol.iterator in actual) pass = [...(actual as Iterable<unknown>)].some((x) => x === expected);
      else throw new AssertionError({ message: `${label ? `${label}: ` : ''}toContain needs a string or an iterable, got ${show(actual)}` });
      check(pass, 'toContain', `to contain ${show(expected)}`, expected);
    },
    toThrow(expected) {
      if (typeof actual !== 'function') throw new AssertionError({ message: `${label ? `${label}: ` : ''}toThrow needs a function` });
      let threw = false;
      let error: unknown;
      try {
        (actual as () => unknown)();
      } catch (err) {
        threw = true;
        error = err;
      }
      let pass = threw;
      if (threw && expected !== undefined) {
        if (typeof expected === 'string') pass = messageOf(error).includes(expected);
        else if (expected instanceof RegExp) pass = new RegExp(expected).test(messageOf(error));
        else pass = error instanceof expected;
      }
      const what = expected === undefined ? 'to throw' : `to throw ${typeof expected === 'function' ? expected.name : show(expected)}`;
      check(pass, 'toThrow', threw ? `${what} (it threw ${show(error)})` : what, expected);
    },
    toBeLessThan(expected) {
      check((actual as number) < expected, 'toBeLessThan', `to be less than ${show(expected)}`, expected);
    },
    toBeGreaterThan(expected) {
      check((actual as number) > expected, 'toBeGreaterThan', `to be greater than ${show(expected)}`, expected);
    },
    toHaveLength(expected) {
      const length = actual !== null && actual !== undefined ? (actual as { length?: unknown }).length : undefined;
      check(length === expected, 'toHaveLength', `to have length ${expected} (it has ${show(length)})`, expected);
    },
    toBeUndefined() {
      check(actual === undefined, 'toBeUndefined', 'to be undefined');
    },
    toBeNull() {
      check(actual === null, 'toBeNull', 'to be null');
    },
  };
  return self;
}

export const expect: Expect = Object.assign((actual: unknown, message?: string): Matchers => matchers(actual, message, false), {
  stringMatching(expected: RegExp | string): unknown {
    const m: Asymmetric = {
      [ASYMMETRIC]: (actual: unknown) => typeof actual === 'string' && new RegExp(expected).test(actual),
      toString: () => `StringMatching ${String(expected)}`,
    };
    return m;
  },
});
