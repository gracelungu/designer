// Design tokens straight from the repo's stylesheets: CSS custom properties in
// :root, theme selectors and Tailwind v4 @theme blocks. Edits are written back
// to the exact declaration, without going through Claude (the "fast path").
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

export interface Token {
  name: string;
  value: string;
  file: string;
  line: number;
  selector: string;
  kind: 'color' | 'size' | 'font' | 'shadow' | 'other';
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', 'storybook-static', 'release']);

async function cssFiles(dir: string, acc: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 8 || acc.length > 300) return acc;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) await cssFiles(p, acc, depth + 1);
    } else if (/\.(css|scss|pcss)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

export function tokenKind(name: string, value: string): Token['kind'] {
  const v = value.trim().toLowerCase();
  if (/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color-mix\()/.test(v) || /color|bg|background|fg|border|accent|brand/.test(name)) return 'color';
  if (/shadow/.test(name)) return 'shadow';
  if (/font|family/.test(name) && !/size|weight/.test(name)) return 'font';
  if (/^-?[\d.]+(px|rem|em|%|vh|vw)?$/.test(v) || /space|radius|size|gap|padding|margin|width|height/.test(name)) return 'size';
  return 'other';
}

/** Find custom-property declarations in a stylesheet, with the selector or at-rule they live in. */
export function parseTokens(css: string, file: string): Token[] {
  const out: Token[] = [];
  const stack: string[] = [];
  let buf = '';
  let line = 1;
  let declStart = 1;
  let inComment = false;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (inComment) {
      if (ch === '*' && css[i + 1] === '/') {
        inComment = false;
        i++;
      } else if (ch === '\n') line++;
      continue;
    }
    if (ch === '/' && css[i + 1] === '*') {
      inComment = true;
      i++;
      continue;
    }
    if (ch === '\n') line++;
    if (ch === '{') {
      stack.push(buf.trim());
      buf = '';
    } else if (ch === '}') {
      stack.pop();
      buf = '';
    } else if (ch === ';') {
      const decl = buf.trim();
      const m = /^(--[\w-]+)\s*:\s*([\s\S]+)$/.exec(decl);
      if (m && stack.length) {
        out.push({ name: m[1], value: m[2].trim(), file, line: declStart, selector: stack.join(' '), kind: tokenKind(m[1], m[2]) });
      }
      buf = '';
    } else {
      if (!buf.trim() && ch.trim()) declStart = line;
      buf += ch;
    }
  }
  return out;
}

export async function findTokens(cwd: string): Promise<Token[]> {
  const files = await cssFiles(cwd);
  const all: Token[] = [];
  for (const f of files) all.push(...parseTokens(await readFile(f, 'utf8').catch(() => ''), relative(cwd, f)));
  return all;
}

/** Replace one declaration's value. The name must still be on that line, so a stale edit fails instead of writing the wrong place. */
export function replaceTokenValue(css: string, line: number, name: string, value: string): string {
  if (/[;{}]/.test(value)) throw new Error('A token value cannot contain ; { or }');
  const lines = css.split('\n');
  const idx = line - 1;
  const re = new RegExp(`(${name.replace(/[-]/g, '\\-')}\\s*:\\s*)([^;]*)(;?)`);
  if (idx < 0 || idx >= lines.length || !re.test(lines[idx])) throw new Error(`${name} is no longer on line ${line}; reload the tokens.`);
  lines[idx] = lines[idx].replace(re, (_m, a: string, _b: string, c: string) => `${a}${value}${c}`);
  return lines.join('\n');
}

export async function updateToken(cwd: string, file: string, line: number, name: string, value: string) {
  const abs = resolve(cwd, file);
  if (!abs.startsWith(resolve(cwd) + sep)) throw new Error('That file is outside the project');
  const before = await readFile(abs, 'utf8');
  const after = replaceTokenValue(before, line, name, value);
  await writeFile(abs, after);
  return { path: file, before, after };
}
