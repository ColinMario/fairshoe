/** fairshoe stays self-contained, so it is the public repository fairshoe as it is. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from './harness.ts';

const ROOT = new URL('../', import.meta.url);
const SRC = new URL('../src/', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'));
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('package boundary', () => {
  it('imports nothing but its own files: no package of its server, no third-party module, no Node or browser API', () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      // Code only: comments may name APIs.
      const text = code(readFileSync(new URL(f, SRC), 'utf8'));
      const specifiers = [...text.matchAll(/(?:import|export)[^'";]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const s of specifiers) expect(s, `${f} imports ${s}`).toMatch(/^\.\//);
      expect(text, `${f} uses a platform API`).not.toMatch(/\b(?:require\(|process\.|globalThis|window\.|document\.|TextEncoder|crypto\.)/);
    }
  });

  it('declares no dependencies, not even to test it: npm test runs on node:test', () => {
    expect(pkg.name).toBe('fairshoe');
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.scripts.test).toBe('node --test "test/*.test.ts"');
    // Run from a checkout, not installed: Node strips the types of no file under node_modules (README).
    expect(pkg.bin).toBeUndefined();
    expect(statSync(new URL('bin/fairshoe-verify', ROOT)).mode & 0o111).not.toBe(0);
  });

  it('runs on Node as it is: every relative import names its file, and nothing else is imported but node: modules', () => {
    const files = ['bin/fairshoe-verify', 'web/build.mjs', 'vectors/generate-node.mjs'];
    for (const dir of ['src', 'test', 'bin']) for (const f of readdirSync(new URL(`${dir}/`, ROOT))) if (f.endsWith('.ts')) files.push(`${dir}/${f}`);
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const text = code(readFileSync(new URL(f, ROOT), 'utf8'));
      const specifiers = [...text.matchAll(/(?:import|export)\s[^'";]*?from\s+['"]([^'"]+)['"]|import\(\s*(?:\/\*.*?\*\/\s*)?['"]([^'"]+)['"]/g)].map((m) => (m[1] ?? m[2])!);
      if (!f.startsWith('src/') && f !== 'vectors/generate-node.mjs') expect(specifiers.length, f).toBeGreaterThan(0);
      for (const s of specifiers) expect(s, `${f} imports ${s}`).toMatch(/^(?:\.\.?\/.*\.(?:ts|mjs|js)|node:[a-z/_]+)$/);
    }
  });

  it('names no product of the server it was written for, in any file (the public repository is fairshoe only)', () => {
    const root = ROOT;
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => !f.split(/[\\/]/).includes('node_modules') && statSync(new URL(f, root)).isFile());
    expect(files).toContain('SPEC.md');
    expect(files.length).toBeGreaterThan(15);
    // Spelt out in pieces, so this file passes its own test.
    const banned = new RegExp(['au', 'rum'].join(''), 'i');
    for (const f of files) {
      expect(banned.test(f), f).toBe(false);
      expect(banned.test(readFileSync(new URL(f, root), 'utf8')), `${f} names it`).toBe(false);
    }
  });
});
