// The repo's tokens (CSS custom properties and Tailwind theme values) next to the Figma variables
// pulled into the repo, so both sides read from one place and drift shows up.
//
// Files in the project, both committed so the team shares them:
//   .designer/figma-variables.json  the last Figma variables pulled (desktop MCP) or imported (JSON)
//   .designer/token-links.json      Figma variable name -> code token name, where names differ
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { findTokens, replaceTokenValue } from './tokens.js';
import type { FigmaClient } from './figma.js';
import { parseFigmaVariables, summarize, syncTokens, toCodeValue, type CodeToken, type FigmaVariable, type SyncSummary, type TokenKind, type TokenPair } from '../shared/tokenSync.js';

export const SNAPSHOT_FILE = '.designer/figma-variables.json';
export const LINKS_FILE = '.designer/token-links.json';

export interface FigmaSnapshot {
  source: 'figma-desktop' | 'import';
  pulledAt: string;
  variables: FigmaVariable[];
}

export interface TokenReport {
  pairs: TokenPair[];
  summary: SyncSummary;
  figma: { source: FigmaSnapshot['source']; pulledAt: string; count: number } | null;
  links: Record<string, string>;
}

// ---------- Tailwind config ----------

type Lit = { kind: 'str'; value: string; line: number } | { kind: 'num'; value: string; line: number } | { kind: 'obj'; entries: [string, Lit][] } | { kind: 'arr'; items: Lit[] } | { kind: 'skip' };

/** Blanks out comments, keeping line breaks and string contents, so positions stay right. */
function stripComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      out += ch;
      for (i++; i < src.length && src[i] !== q; i++) {
        if (src[i] === '\\') out += src[i++];
        out += src[i];
      }
      out += src[i] ?? '';
    } else if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') (out += ' '), i++;
      out += src[i] ?? '';
    } else if (ch === '/' && src[i + 1] === '*') {
      for (; i < src.length && !(src[i] === '*' && src[i + 1] === '/'); i++) out += src[i] === '\n' ? '\n' : ' ';
      out += '  ';
      i++;
    } else out += ch;
  }
  return out;
}

/** A forgiving reader for the object literals in tailwind.config.*: it keeps literal values and skips code. */
class LiteralReader {
  i = 0;
  constructor(readonly s: string) {}
  line(pos = this.i) {
    let n = 1;
    for (let k = 0; k < pos; k++) if (this.s[k] === '\n') n++;
    return n;
  }
  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  str(): string {
    const q = this.s[this.i++];
    let v = '';
    while (this.i < this.s.length && this.s[this.i] !== q) {
      if (this.s[this.i] === '\\') this.i++;
      v += this.s[this.i++];
    }
    this.i++;
    return v;
  }
  /** Skips one expression we don't understand, up to the next , or closing bracket. */
  skip() {
    let depth = 0;
    while (this.i < this.s.length) {
      const ch = this.s[this.i];
      if (ch === '"' || ch === "'" || ch === '`') {
        this.str();
        continue;
      }
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) {
        if (depth === 0) return;
        depth--;
      } else if (ch === ',' && depth === 0) return;
      this.i++;
    }
  }
  value(): Lit {
    this.ws();
    const ch = this.s[this.i];
    const start = this.i;
    if (ch === '{') return this.object();
    if (ch === '[') return this.array();
    if ((ch === '"' || ch === "'" || (ch === '`' && !this.s.slice(this.i, this.s.indexOf('`', this.i + 1)).includes('${'))) && ch) {
      const line = this.line();
      const v = this.str();
      this.ws();
      if (this.s[this.i] !== ',' && this.s[this.i] !== '}' && this.s[this.i] !== ']') {
        this.skip();
        return { kind: 'skip' };
      }
      return { kind: 'str', value: v, line };
    }
    const m = /^-?\d*\.?\d+(?=\s*[,}\]])/.exec(this.s.slice(this.i));
    if (m) {
      this.i += m[0].length;
      return { kind: 'num', value: m[0], line: this.line(start) };
    }
    this.skip();
    return { kind: 'skip' };
  }
  object(): Lit {
    const entries: [string, Lit][] = [];
    this.i++; // {
    for (;;) {
      this.ws();
      const ch = this.s[this.i];
      if (ch === undefined) break;
      if (ch === '}') {
        this.i++;
        break;
      }
      if (ch === ',') {
        this.i++;
        continue;
      }
      let key: string | undefined;
      if (ch === '"' || ch === "'") key = this.str();
      else {
        const m = /^[\w$-]+/.exec(this.s.slice(this.i));
        if (m && !this.s.startsWith('...', this.i)) {
          key = m[0];
          this.i += m[0].length;
        }
      }
      this.ws();
      if (key === undefined || this.s[this.i] !== ':') {
        // Spread, computed key, shorthand or method: not a literal.
        this.skip();
        if (this.s[this.i] === '}') continue;
        continue;
      }
      this.i++; // :
      entries.push([key, this.value()]);
    }
    return { kind: 'obj', entries };
  }
  array(): Lit {
    const items: Lit[] = [];
    this.i++; // [
    for (;;) {
      this.ws();
      const ch = this.s[this.i];
      if (ch === undefined) break;
      if (ch === ']') {
        this.i++;
        break;
      }
      if (ch === ',') {
        this.i++;
        continue;
      }
      items.push(this.value());
    }
    return { kind: 'arr', items };
  }
}

const TW_CATEGORIES: Record<string, TokenKind> = {
  colors: 'color',
  spacing: 'size',
  borderRadius: 'size',
  fontSize: 'size',
  fontFamily: 'font',
  boxShadow: 'shadow',
  fontWeight: 'other',
  lineHeight: 'size',
  letterSpacing: 'size',
};

export interface TailwindToken extends CodeToken {
  /** The literal written in the config (for fontFamily stacks and fontSize tuples, the first item). */
  literal: string;
}

/** Reads the theme (and theme.extend) of a Tailwind v3-style config. Tailwind v4's @theme comes in as CSS. */
export function parseTailwindConfig(src: string, file: string): TailwindToken[] {
  const s = stripComments(src);
  const m = /\btheme\s*:\s*\{/.exec(s);
  if (!m) return [];
  const r = new LiteralReader(s);
  r.i = m.index + m[0].length - 1;
  const theme = r.object();
  if (theme.kind !== 'obj') return [];
  const out: TailwindToken[] = [];
  const emit = (category: string, path: string[], lit: Lit) => {
    const kind = TW_CATEGORIES[category];
    const name = [category, ...path].join('.');
    if (lit.kind === 'str' || lit.kind === 'num') {
      out.push({ name, value: lit.value, literal: lit.value, file, line: lit.line, selector: 'tailwind theme', kind, source: 'tailwind' });
    } else if (lit.kind === 'arr') {
      const strs = lit.items.filter((x): x is Extract<Lit, { kind: 'str' }> => x.kind === 'str');
      if (!strs.length) return;
      // fontFamily: ['Inter', 'sans-serif'] is one stack; fontSize: ['1rem', { lineHeight }] is a size.
      const value = category === 'fontFamily' ? strs.map((x) => (/\s/.test(x.value) ? `"${x.value}"` : x.value)).join(', ') : strs[0].value;
      out.push({ name, value, literal: strs[0].value, file, line: strs[0].line, selector: 'tailwind theme', kind, source: 'tailwind' });
    } else if (lit.kind === 'obj') {
      for (const [k, v] of lit.entries) emit(category, [...path, k], v);
    }
  };
  const visit = (entries: [string, Lit][]) => {
    for (const [k, v] of entries) {
      if (k === 'extend' && v.kind === 'obj') visit(v.entries);
      else if (TW_CATEGORIES[k]) emit(k, [], v);
    }
  };
  visit(theme.entries);
  return out;
}

const TW_NAMES = ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.mjs', 'tailwind.config.cjs', 'tailwind.config.mts', 'tailwind.config.cts'];

export async function findTailwindTokens(cwd: string): Promise<TailwindToken[]> {
  const dirs = [cwd];
  // Monorepos: apps/* and packages/* one level down.
  for (const group of ['apps', 'packages']) {
    const entries = await readdir(join(cwd, group), { withFileTypes: true }).catch(() => []);
    for (const e of entries) if (e.isDirectory()) dirs.push(join(cwd, group, e.name));
  }
  const out: TailwindToken[] = [];
  for (const d of dirs) {
    for (const n of TW_NAMES) {
      const src = await readFile(join(d, n), 'utf8').catch(() => null);
      if (src !== null) out.push(...parseTailwindConfig(src, relative(cwd, join(d, n))));
    }
  }
  return out;
}

/** Replaces one literal in a Tailwind config. The old literal must still be on that line. */
export function replaceTailwindLiteral(src: string, line: number, oldLiteral: string, newLiteral: string): string {
  if (/["'`\\\n]/.test(newLiteral)) throw new Error('That value cannot be written into the Tailwind config');
  const lines = src.split('\n');
  const idx = line - 1;
  const esc = oldLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = new RegExp(`(["'\`])${esc}\\1`);
  const bare = new RegExp(`(:\\s*)${esc}(?=\\s*[,}\\]]|\\s*$)`);
  if (idx < 0 || idx >= lines.length) throw new Error(`Line ${line} is no longer in the file; reload the tokens.`);
  if (quoted.test(lines[idx])) lines[idx] = lines[idx].replace(quoted, (_m, q: string) => `${q}${newLiteral}${q}`);
  else if (/^-?\d*\.?\d+$/.test(oldLiteral) && bare.test(lines[idx])) lines[idx] = lines[idx].replace(bare, (_m, a: string) => `${a}${/^-?\d*\.?\d+$/.test(newLiteral) ? newLiteral : `'${newLiteral}'`}`);
  else throw new Error(`${oldLiteral} is no longer on line ${line}; reload the tokens.`);
  return lines.join('\n');
}

// ---------- the project's files ----------

async function readJson<T>(path: string): Promise<T | null> {
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function writeJson(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n');
}

export const readSnapshot = (cwd: string) => readJson<FigmaSnapshot>(join(cwd, SNAPSHOT_FILE));
export const readLinks = async (cwd: string) => (await readJson<Record<string, string>>(join(cwd, LINKS_FILE))) ?? {};

export async function codeTokens(cwd: string): Promise<CodeToken[]> {
  const css = (await findTokens(cwd)).map((t) => ({ ...t, source: 'css' as const }));
  return [...css, ...(await findTailwindTokens(cwd))];
}

export async function tokenReport(cwd: string): Promise<TokenReport> {
  const [code, snap, links] = await Promise.all([codeTokens(cwd), readSnapshot(cwd), readLinks(cwd)]);
  const pairs = syncTokens(snap?.variables ?? [], code, links);
  return { pairs, summary: summarize(pairs), figma: snap ? { source: snap.source, pulledAt: snap.pulledAt, count: snap.variables.length } : null, links };
}

/** Saves Figma variables into the project. Pulls from the desktop app merge (they only cover the selection); imports replace. */
export async function saveSnapshot(cwd: string, vars: FigmaVariable[], source: FigmaSnapshot['source'], now = new Date()) {
  const prev = source === 'figma-desktop' ? await readSnapshot(cwd) : null;
  const key = (v: FigmaVariable) => `${v.name}@${v.mode ?? ''}`;
  const merged = new Map((prev?.variables ?? []).map((v) => [key(v), v]));
  for (const v of vars) merged.set(key(v), v);
  const variables = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  await writeJson(join(cwd, SNAPSHOT_FILE), { source, pulledAt: now.toISOString(), variables } satisfies FigmaSnapshot);
  return variables.length;
}

/**
 * The desktop MCP server's get_variable_defs answers with the variables used by the current selection,
 * as a JSON (or Python-style) object of name -> value. Text and effect styles come back as
 * "Font(...)" / "Effect(...)" strings; those are styles, not variables, so they are left out.
 */
export function parseVariableDefs(text: string): FigmaVariable[] {
  const body = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!body) return [];
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // Python-style dict: turn each 'single-quoted' string into a JSON string.
    obj = JSON.parse(body.replace(/'((?:[^'\\]|\\.)*)'/g, (_m, inner: string) => JSON.stringify(inner.replace(/\\'/g, "'")))) as Record<string, unknown>;
  }
  return parseFigmaVariables(Object.fromEntries(Object.entries(obj).filter(([, v]) => !(typeof v === 'string' && /^(Font|Effect|Grid)\(/.test(v)))));
}

export async function pullFromFigma(cwd: string, client: FigmaClient) {
  if (!client.has('get_variable_defs')) throw new Error("This Figma MCP server can't read variables (no get_variable_defs). Update the Figma desktop app.");
  const r = await client.call('get_variable_defs', { clientLanguages: 'typescript,css', clientFrameworks: 'react' });
  const text = (r.content ?? []).map((c) => c.text ?? '').join('\n');
  if (r.isError) throw new Error(text || 'Figma could not read variables. Select a frame that uses them and try again.');
  const vars = parseVariableDefs(text);
  if (!vars.length) throw new Error('Figma returned no variables. Select a frame (or the whole page) that uses your variables, then pull again.');
  await saveSnapshot(cwd, vars, 'figma-desktop');
  return vars.length;
}

export async function importVariables(cwd: string, json: string) {
  let vars: FigmaVariable[];
  try {
    vars = parseFigmaVariables(json);
  } catch (e) {
    throw new Error(`That isn't a Figma variables file: ${(e as Error).message}`);
  }
  if (!vars.length) throw new Error('No variables found in that file.');
  await saveSnapshot(cwd, vars, 'import');
  return vars.length;
}

export async function setLink(cwd: string, figmaName: string, codeName: string | null) {
  const links = await readLinks(cwd);
  if (codeName) links[figmaName] = codeName;
  else delete links[figmaName];
  await writeJson(join(cwd, LINKS_FILE), links);
  return links;
}

/** Makes the code match Figma for one drifted pair. Returns the file change, for the Changes list. */
export async function useFigmaValue(cwd: string, key: string): Promise<{ path: string; before: string; after: string }> {
  const report = await tokenReport(cwd);
  const pair = report.pairs.find((p) => p.key === key);
  if (!pair?.code || !pair.figma) throw new Error('That token is no longer paired with a Figma variable; reload the tokens.');
  if (pair.status !== 'drift') throw new Error(`${pair.code.name} already matches Figma.`);
  const c = pair.code;
  if (pair.mode && /dark|night/i.test(pair.mode) && !/dark/i.test(c.selector)) throw new Error(`${c.name} has no ${pair.mode} override in code, so changing it would change every mode. Ask Claude to add a ${pair.mode} value.`);
  if (/var\(/.test(c.value)) throw new Error(`${c.name} points at another token (${c.value}). Change that token instead, or ask Claude.`);
  const abs = resolve(cwd, c.file);
  if (!abs.startsWith(resolve(cwd) + sep)) throw new Error('That file is outside the project');
  const before = await readFile(abs, 'utf8');
  let after: string;
  if (c.source === 'tailwind') {
    const literal = (c as TailwindToken).literal ?? c.value;
    const next = c.kind === 'font' ? pair.figma.value.trim() : toCodeValue(pair.figma.value, literal);
    after = replaceTailwindLiteral(before, c.line, literal, next);
  } else {
    after = replaceTokenValue(before, c.line, c.name, toCodeValue(pair.figma.value, c.value));
  }
  await writeFile(abs, after);
  return { path: c.file, before, after };
}
