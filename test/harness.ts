/**
 * The test API of these tests: vitest's when vitest runs them (the test suite of the server this library was written
 * for), else the one in expect.ts on node:test, for `npm test` with nothing installed.
 */
import type { Api } from './expect.ts';

// A name in a variable: this repository does not install vitest, so no type checker or bundler should look for it.
const VITEST = 'vitest';
const api = (process.env.VITEST ? await import(/* @vite-ignore */ VITEST) : await import('./expect.ts')) as Api;

export const describe: Api['describe'] = api.describe;
export const it: Api['it'] = api.it;
export const expect: Api['expect'] = api.expect;
