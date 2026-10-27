/**
 * The matchers mean the same under vitest and under expect.ts (npm test): each case passes or fails alike in both, so
 * a test that passes under one does not pass vacuously under the other.
 */
import { describe, expect, it } from './harness.ts';

const fails = (assertion: () => void): void => expect(assertion).toThrow();

describe('test harness', () => {
  it('toBe is Object.is', () => {
    expect(1).toBe(1);
    expect(Number.NaN).toBe(Number.NaN);
    fails(() => expect(0).toBe(-0));
    fails(() => expect({}).toBe({}));
    expect({}).not.toBe({});
    fails(() => expect(1).not.toBe(1));
  });

  it('toEqual compares deeply and ignores undefined properties', () => {
    expect({ a: 1, b: undefined }).toEqual({ a: 1 });
    expect({ a: [1, { b: 'x' }] }).toEqual({ a: [1, { b: 'x' }] });
    expect(new Uint8Array([1, 2])).toEqual(new Uint8Array([1, 2]));
    expect(['xaby']).toEqual([expect.stringMatching(/ab/)]);
    expect(['xaby']).toEqual([expect.stringMatching('a.y')]);
    fails(() => expect({ a: 1 }).toEqual({ a: 2 }));
    fails(() => expect({ a: 1, c: 3 }).toEqual({ a: 1 }));
    fails(() => expect([1, 2]).toEqual([1, 2, 3]));
    fails(() => expect([{ a: 1, b: 2 }]).toEqual([{ a: 1 }]));
    fails(() => expect(new Uint8Array([1, 2])).toEqual(new Uint8Array([1, 3])));
    fails(() => expect(['xy']).toEqual([expect.stringMatching(/ab/)]));
    fails(() => expect([]).toEqual({}));
    fails(() => expect({ a: 1 }).not.toEqual({ a: 1 }));
  });

  it('toMatchObject matches a subset, arrays element by element with the same length', () => {
    expect({ a: 1, b: 2 }).toMatchObject({ a: 1 });
    expect({ a: { x: 1, y: 2 }, b: 2 }).toMatchObject({ a: { x: 1 } });
    expect({ a: [{ x: 1, y: 2 }] }).toMatchObject({ a: [{ x: 1 }] });
    expect({ e: ['outcome: x'] }).toMatchObject({ e: [expect.stringMatching(/^outcome/)] });
    fails(() => expect({ a: [1, 2] }).toMatchObject({ a: [1] }));
    fails(() => expect({ a: 1 }).toMatchObject({ b: undefined }));
    fails(() => expect({ a: 1 }).toMatchObject({ a: 2 }));
    fails(() => expect({ a: { x: 1 } }).toMatchObject({ a: { x: 1, y: 2 } }));
    fails(() => expect({ a: 1 }).not.toMatchObject({ a: 1 }));
  });

  it('toMatch takes a regular expression or looks for a string', () => {
    expect('abc').toMatch(/b/);
    expect('abc').toMatch('bc');
    fails(() => expect('abc').toMatch('.'));
    fails(() => expect('abc').toMatch(/x/));
    expect('abc').not.toMatch(/x/);
    fails(() => expect('abc').not.toMatch(/a/));
  });

  it('toContain looks for a string or an element (===)', () => {
    expect([1, 2]).toContain(2);
    expect('abc').toContain('b');
    fails(() => expect([{ a: 1 }]).toContain({ a: 1 }));
    fails(() => expect([1, 2]).toContain(3));
    fails(() => expect('abc').toContain('x'));
  });

  it('toThrow takes nothing, a class, a regular expression or a string', () => {
    const bad = (): never => {
      throw new RangeError('bad x');
    };
    expect(bad).toThrow();
    expect(bad).toThrow(RangeError);
    expect(bad).toThrow(/bad/);
    expect(bad).toThrow('bad');
    fails(() => expect(bad).toThrow(TypeError));
    fails(() => expect(bad).toThrow(/good/));
    fails(() => expect(() => undefined).toThrow());
    fails(() => expect(bad).not.toThrow());
  });

  it('order, length, undefined and null', () => {
    expect(1).toBeLessThan(2);
    expect(2).toBeGreaterThan(1);
    fails(() => expect(2).toBeLessThan(2));
    fails(() => expect(2).toBeGreaterThan(2));
    expect([1, 2]).toHaveLength(2);
    fails(() => expect('abc').toHaveLength(2));
    expect(undefined).toBeUndefined();
    fails(() => expect(null).toBeUndefined());
    expect(null).toBeNull();
    fails(() => expect(undefined).toBeNull());
    expect(0).not.toBeNull();
  });

  it('a message names the failing check', () => {
    expect(() => expect(1, 'the answer').toBe(2)).toThrow(/the answer/);
  });

  it.each([
    [1, 'one'],
    [2, 'two'],
  ] as const)('it.each passes each row: %i', (n, word) => {
    expect(['one', 'two'][n - 1]).toBe(word);
  });
});
