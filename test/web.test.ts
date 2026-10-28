/**
 * The verifier page (web/build.mjs): its library runs in a bare ECMAScript context and reports what the library
 * reports, the page loads nothing and runs only its own script, the page's code works, and web/index.html (where it
 * is built) is the build of this source.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { collect, verifyBundle } from '../bin/report.ts';
import { bundle, page } from '../web/build.mjs';
import { describe, expect, it } from './harness.ts';

const ROOT = new URL('../', import.meta.url);
const EXAMPLES = readdirSync(new URL('examples/', ROOT)).map((f) => ({ name: f, value: JSON.parse(readFileSync(new URL(`examples/${f}`, ROOT), 'utf8')) as unknown }));

interface Lib {
  ALG: string;
  LIB: string;
  collect: typeof collect;
  verifyBundle: typeof verifyBundle;
}

/** The bundle in a context with nothing but ECMAScript: no process, require, Buffer, crypto, TextEncoder, fetch. */
function bare(code: string): Lib {
  const ctx = createContext({});
  runInContext(`${code}\nglobalThis.fairshoe = fairshoe;`, ctx);
  return (ctx as { fairshoe: Lib }).fairshoe;
}

/** A DOM just big enough for web/ui.js. */
class Element {
  readonly tag: string;
  children: Element[] = [];
  textContent = '';
  className = '';
  hidden = false;
  files: Array<{ name: string; text: () => Promise<string> }> = [];
  private text_ = '';
  /** As on a file input, setting the value to '' clears the files chosen. */
  get value(): string {
    return this.text_;
  }
  set value(v: string) {
    this.text_ = v;
    if (v === '') this.files = [];
  }
  listeners: Record<string, Array<(event?: unknown) => unknown>> = {};
  classList = { add: (): void => undefined, remove: (): void => undefined };
  constructor(tag: string) {
    this.tag = tag;
  }
  append(...c: Element[]): void {
    this.children.push(...c);
  }
  replaceChildren(...c: Element[]): void {
    this.children = c;
  }
  addEventListener(type: string, fn: (event?: unknown) => unknown): void {
    (this.listeners[type] ??= []).push(fn);
  }
  async fire(type: string, event?: unknown): Promise<void> {
    for (const fn of this.listeners[type] ?? []) await fn(event);
  }
  text(): string {
    return [this.textContent, ...this.children.map((c) => c.text())].filter(Boolean).join('\n');
  }
}

describe('verifier page', () => {
  it('the library in the page runs without any platform API and reports what the library reports', () => {
    const code = bundle();
    // Code only: the comments of the source stay in the page, and they may name APIs.
    const codeOnly = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/\b(?:require\(|process\.|Buffer\b|node:|import\s*[{(*]|export\s|globalThis|window\.|document\.|TextEncoder|crypto\.)/);
    const lib = bare(code);
    expect(`${lib.ALG} ${lib.LIB}`).toBe('fairshoe/v1 fairshoe@1.2.0');
    expect(EXAMPLES.length).toBeGreaterThan(3);
    for (const ex of EXAMPLES) {
      const inPage = lib.verifyBundle(lib.collect([ex]));
      expect(JSON.stringify(inPage), ex.name).toBe(JSON.stringify(verifyBundle(collect([ex]))));
    }
  });

  it('loads nothing, sends nothing and runs only its own script', async () => {
    const html = await page();
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? '';
    expect(csp).toMatch(/^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'; /);
    expect(csp).not.toMatch(/unsafe-inline'[^;]*script|script-src[^;]*unsafe/);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(1);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(csp).toContain(`'sha256-${createHash('sha256').update(scripts[0]!, 'utf8').digest('base64')}'`);
    // Attribute/CSS resource references, not JavaScript variables such as `action = 0`. Code purity is checked above.
    const markup = html.replace(/<script>[\s\S]*?<\/script>/g, '');
    expect(markup).not.toMatch(/\b(?:src|href|action)\s*=|@import|url\(|%[A-Z_]+%/);
  });

  it("the page's code verifies the files chosen, dropped or pasted and shows the reasons as text", async () => {
    const html = await page();
    const ids = new Map<string, Element>();
    const document = {
      getElementById: (id: string): Element => {
        if (!ids.has(id)) ids.set(id, new Element(id));
        return ids.get(id)!;
      },
      createElement: (tag: string): Element => new Element(tag),
    };
    runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)![1]!, createContext({ document }));
    const get = (id: string): Element => document.getElementById(id);
    const file = (name: string) => ({ name, text: async () => readFileSync(new URL(`examples/${name}`, ROOT), 'utf8') });

    get('files').files = [file('baccarat-flipped-winner.json')];
    await get('verify').fire('click');
    expect(get('verdict').className).toBe('verdict failed');
    expect(get('checks').text()).toContain('error: outcome: the winner is player, the proof says "banker"');
    expect(JSON.parse(get('json').textContent)).toMatchObject({ status: 'failed' });

    await get('clear').fire('click');
    expect(get('result').hidden).toBe(true);
    await get('drop').fire('drop', { preventDefault: () => undefined, dataTransfer: { files: [file('dragon-tiger.json')] } });
    expect(get('drop').textContent).toBe('dragon-tiger.json (dropped)');
    await get('verify').fire('click');
    expect(get('verdict')).toMatchObject({ className: 'verdict provable', hidden: false });

    await get('clear').fire('click');
    get('text').value = '{ "kept": ';
    await get('verify').fire('click');
    expect(get('verdict').textContent).toMatch(/^The input could not be read: pasted text: not JSON/);
    get('text').value = readFileSync(new URL('examples/dragon-tiger-without-own-records.json', ROOT), 'utf8');
    await get('verify').fire('click');
    expect(get('verdict').className).toBe('verdict ok');
    expect(get('checks').text()).toContain('not provable: the cut the player asked for on this shoe is not given');
  });

  it('web/index.html, where it is built, is the build of this source (node web/build.mjs)', async () => {
    const built = new URL('web/index.html', ROOT);
    if (!existsSync(built)) return;
    expect(readFileSync(built, 'utf8') === (await page()), 'web/index.html is out of date: run node web/build.mjs').toBe(true);
  });
});
