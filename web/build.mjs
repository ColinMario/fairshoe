#!/usr/bin/env node
/**
 * Builds the verifier page web/index.html: one file with no external resource (it works offline, opened from disk),
 * the library (src/) and the checks of fairshoe-verify (bin/report.ts) inlined as plain JavaScript, its only script
 * allowed by hash (Content-Security-Policy: no network, no other script). Node strips the types itself
 * (node:module stripTypeScriptTypes); the modules are wrapped in functions in the order of their imports. Nothing to
 * install.
 *
 *   node web/build.mjs              writes web/index.html
 *   node web/build.mjs <file>       writes <file>
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ENTRY = resolve(ROOT, 'bin/report.ts');

/** TypeScript to JavaScript by erasing the types (positions stay). Node warns that the function is experimental: not here. */
function strip(code) {
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (!String(warning).includes('stripTypeScriptTypes')) emit.call(process, warning, ...rest);
  };
  try {
    return stripTypeScriptTypes(code, { mode: 'strip' });
  } finally {
    process.emitWarning = emit;
  }
}

const IMPORT = /^import\s*\{([^}]*)\}\s*from\s*'([^']+)';?[ \t]*$/gm;
const EXPORT_ALL = /^export\s*\*\s*from\s*'([^']+)';?[ \t]*$/gm;
const EXPORT_DECL = /^export\s+((?:async\s+)?function\*?|const|class)\s+([A-Za-z_$][\w$]*)/gm;

/** One module: its imports (path -> [imported, local]), its exports and its code without import and export syntax. */
function parse(file) {
  const where = relative(ROOT, file);
  let code = strip(readFileSync(file, 'utf8'));
  const imports = [];
  const all = [];
  code = code.replace(IMPORT, (_, names, spec) => {
    const pairs = names
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => {
        const m = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(n);
        if (!m) throw new Error(`${where}: cannot read the import ${n}`);
        return [m[1], m[2] ?? m[1]];
      });
    imports.push({ path: resolve(dirname(file), spec), names: pairs });
    return '';
  });
  code = code.replace(EXPORT_ALL, (_, spec) => {
    const path = resolve(dirname(file), spec);
    imports.push({ path, names: [] });
    all.push(path);
    return '';
  });
  const exports = [];
  code = code.replace(EXPORT_DECL, (_, kind, name) => {
    exports.push(name);
    return `${kind} ${name}`;
  });
  const left = /^\s*(?:import|export)\b.*$/m.exec(code);
  if (left) throw new Error(`${where}: unsupported module syntax: ${left[0].trim()}`);
  return { file, where, imports, all, exports, code };
}

/** The library and the report checks as one script that defines `fairshoe` (every export of both). */
export function bundle() {
  const done = new Map();
  const order = [];
  const visit = (file, stack) => {
    if (done.has(file)) return;
    if (stack.includes(file)) throw new Error(`import cycle: ${[...stack, file].map((f) => relative(ROOT, f)).join(' -> ')}`);
    const m = parse(file);
    for (const i of m.imports) visit(i.path, [...stack, file]);
    m.id = `m${order.length}`;
    done.set(file, m);
    order.push(m);
  };
  visit(ENTRY, []);
  const index = done.get(resolve(ROOT, 'src/index.ts'));
  if (!index) throw new Error('bin/report.ts does not import src/index.ts');
  const parts = order.map((m) => {
    const head = m.imports
      .filter((i) => i.names.length > 0)
      .map((i) => `const { ${i.names.map(([a, b]) => (a === b ? a : `${a}: ${b}`)).join(', ')} } = ${done.get(i.path).id};`);
    const spread = m.all.map((p) => `...${done.get(p).id}`);
    const out = `return Object.freeze({ ${[...spread, ...m.exports].join(', ')} });`;
    return `// ${m.where}\nconst ${m.id} = (() => {\n${head.join('\n')}\n${m.code.trim()}\n${out}\n})();`;
  });
  const report = done.get(ENTRY);
  return [
    `// fairshoe ${JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version}: src/ and bin/report.ts, built by web/build.mjs.`,
    "'use strict';",
    'const fairshoe = (() => {',
    ...parts,
    `for (const k of Object.keys(${report.id})) if (k in ${index.id}) throw new Error('two exports named ' + k);`,
    `return Object.freeze({ ...${index.id}, ...${report.id} });`,
    '})();',
  ].join('\n');
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('base64');

/** The page: web/template.html with the bundle and web/ui.js as its one script, allowed by its hash. */
export async function page() {
  const { ALG, LIB } = await import('../src/index.ts');
  const script = `\n${bundle()}\n${readFileSync(resolve(ROOT, 'web/ui.js'), 'utf8').trim()}\n`;
  if (/<\/script|<!--/i.test(script)) throw new Error('the script holds </script or <!--: it cannot be inlined');
  const fill = (text, key, value) => text.split(`%${key}%`).join(value);
  let html = readFileSync(resolve(ROOT, 'web/template.html'), 'utf8');
  html = fill(html, 'SCRIPT_HASH', `sha256-${sha256(script)}`);
  html = fill(html, 'VERSION', `${ALG} (${LIB})`);
  html = fill(html, 'SCRIPT', script);
  return html;
}

function invoked() {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invoked()) {
  const out = resolve(process.argv[2] ?? resolve(ROOT, 'web/index.html'));
  const html = await page();
  writeFileSync(out, html);
  console.log(`${out}: ${html.length} bytes`);
}
