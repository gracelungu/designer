import { cpSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importVariables, parseTailwindConfig, parseVariableDefs, pullFromFigma, readSnapshot, replaceTailwindLiteral, setLink, tokenReport, useFigmaValue } from '../src/server/designTokens';
import { FigmaClient } from '../src/server/figma';
import { fakeFigma } from './fixtures/fakeFigma';

const FIXTURE = join(__dirname, 'fixtures', 'token-repo');
const repo = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'designer-tokens-')));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
};
const TW = readFileSync(join(FIXTURE, 'tailwind.config.ts'), 'utf8');

describe('Tailwind config tokens', () => {
  it('reads theme and theme.extend values, skipping code it cannot read', () => {
    const t = parseTailwindConfig(TW, 'tailwind.config.ts');
    expect(t.map((x) => [x.name, x.value, x.line])).toEqual([
      ['colors.brand.DEFAULT', '#7c3aed', 10],
      ['colors.brand.500', '#8b5cf6', 11],
      ['colors.danger', 'hsl(0, 84%, 60%)', 13],
      ['borderRadius.pill', '9999px', 15],
      ['fontFamily.display', 'Satoshi', 17],
      ['spacing.gutter', '24', 19],
    ]);
    expect(t.every((x) => x.source === 'tailwind')).toBe(true);
    expect(t.find((x) => x.name === 'colors.danger')!.kind).toBe('color');
  });
  it('reads module.exports configs, font stacks and fontSize tuples', () => {
    const t = parseTailwindConfig(
      `module.exports = {\n  theme: {\n    fontFamily: { sans: ['Inter Var', 'sans-serif'] },\n    fontSize: { sm: ['0.875rem', { lineHeight: '1.25rem' }] },\n    colors: ({ colors }) => ({ ...colors }),\n  },\n}`,
      'tailwind.config.js',
    );
    expect(t.map((x) => [x.name, x.value, x.literal])).toEqual([
      ['fontFamily.sans', '"Inter Var", sans-serif', 'Inter Var'],
      ['fontSize.sm', '0.875rem', '0.875rem'],
    ]);
  });
  it('rewrites one literal in place, and refuses a stale edit', () => {
    const out = replaceTailwindLiteral(TW, 11, '#8b5cf6', '#7C3AED');
    expect(out.split('\n')[10]).toBe('          500: "#7C3AED",');
    expect(replaceTailwindLiteral(TW, 19, '24', '32').split('\n')[18]).toBe('      spacing: { gutter: 32 },');
    expect(() => replaceTailwindLiteral(TW, 12, '#8b5cf6', '#000')).toThrow(/no longer/);
    expect(() => replaceTailwindLiteral(TW, 11, '#8b5cf6', "x' + evil")).toThrow();
  });
});

describe('Figma variables in the project', () => {
  it('reads get_variable_defs replies in JSON or Python style, leaving out styles', () => {
    expect(parseVariableDefs(`{'Color/Primary': '#2563EB', 'Body': 'Font(family: "Inter", size: 16)'}`)).toEqual([{ name: 'Color/Primary', value: '#2563EB', type: 'COLOR' }]);
    expect(parseVariableDefs('Variables used: {"Space/4":"16"}')).toEqual([{ name: 'Space/4', value: '16', type: 'FLOAT' }]);
  });

  it('pulls from the Figma desktop server into the project, merging later pulls', async () => {
    const dir = repo();
    const f = await fakeFigma({ selection: '', variables: JSON.stringify({ 'Color/Primary': '#2563EB', 'Radius/Card': '12' }) });
    try {
      const client = new FigmaClient(f.url);
      await client.connect();
      expect(await pullFromFigma(dir, client)).toBe(2);
      const snap = await readSnapshot(dir);
      expect(snap).toMatchObject({ source: 'figma-desktop', variables: [{ name: 'Color/Primary' }, { name: 'Radius/Card' }] });
      expect(f.calls).toContain('tools/call:get_variable_defs');
    } finally {
      await f.close();
    }
    const g = await fakeFigma({ selection: '', variables: JSON.stringify({ 'Color/Success': '#16A34A' }) });
    try {
      const client = new FigmaClient(g.url);
      await client.connect();
      await pullFromFigma(dir, client);
      expect((await readSnapshot(dir))!.variables.map((v) => v.name)).toEqual(['Color/Primary', 'Color/Success', 'Radius/Card']);
    } finally {
      await g.close();
    }
  });

  it('explains an empty selection, and a Figma without variable support', async () => {
    const dir = repo();
    const f = await fakeFigma({ selection: '' });
    const old = await fakeFigma({ selection: '', tools: ['get_metadata'] });
    try {
      const a = new FigmaClient(f.url);
      await a.connect();
      await expect(pullFromFigma(dir, a)).rejects.toThrow(/Nothing is selected/);
      const b = new FigmaClient(old.url);
      await b.connect();
      await expect(pullFromFigma(dir, b)).rejects.toThrow(/get_variable_defs/);
    } finally {
      await f.close();
      await old.close();
    }
  });

  it('reports CSS and Tailwind tokens against imported Figma variables', async () => {
    const dir = repo();
    let r = await tokenReport(dir);
    expect(r.figma).toBeNull();
    expect(r.pairs.every((p) => p.status === 'code-only')).toBe(true);

    await importVariables(dir, readFileSync(join(dir, 'figma-variables.rest.json'), 'utf8'));
    r = await tokenReport(dir);
    expect(r.figma).toMatchObject({ source: 'import', count: 10 });
    const by = (k: string) => r.pairs.find((p) => p.key === k)!;
    expect(by('Color/Primary').status).toBe('in-sync');
    expect(by('Space/4')).toMatchObject({ status: 'in-sync', code: { value: '1rem' } });
    expect(by('Radius/Card').status).toBe('drift');
    expect(by('Color/Surface@Dark').status).toBe('drift');
    expect(by('Brand/500')).toMatchObject({ status: 'in-sync', code: { source: 'tailwind', name: 'colors.brand.500' } });
    expect(by('Font/Body').status).toBe('in-sync');
    expect(by('Color/Success').status).toBe('figma-only');
    expect(r.summary).toEqual({ inSync: 7, drift: 2, figmaOnly: 1, codeOnly: 7 });
    await expect(importVariables(dir, 'not json')).rejects.toThrow(/Figma variables/);
  });

  it('links a Figma variable to a differently named token', async () => {
    const dir = repo();
    await importVariables(dir, JSON.stringify({ 'Layout/Gutter': 13 }));
    expect((await tokenReport(dir)).pairs.find((p) => p.key === 'Layout/Gutter')!.status).toBe('figma-only');
    await setLink(dir, 'Layout/Gutter', '--legacy-gutter');
    expect(JSON.parse(readFileSync(join(dir, '.designer', 'token-links.json'), 'utf8'))).toEqual({ 'Layout/Gutter': '--legacy-gutter' });
    expect((await tokenReport(dir)).pairs.find((p) => p.key === 'Layout/Gutter')).toMatchObject({ status: 'in-sync', match: 'linked' });
    await setLink(dir, 'Layout/Gutter', null);
    expect((await tokenReport(dir)).links).toEqual({});
  });

  it('makes code match Figma for drifted CSS and Tailwind tokens', async () => {
    const dir = repo();
    await importVariables(dir, readFileSync(join(dir, 'figma-variables.rest.json'), 'utf8'));
    const c1 = await useFigmaValue(dir, 'Radius/Card');
    expect(c1.path).toBe(join('src', 'styles', 'tokens.css'));
    expect(c1.after).toContain('--radius-card: 12px;');
    const c2 = await useFigmaValue(dir, 'Color/Surface@Dark');
    expect(c2.after).toContain('--color-surface: #121214;');
    expect(c2.after).toContain('--color-surface: #ffffff;');
    expect((await tokenReport(dir)).summary.drift).toBe(0);

    await importVariables(dir, JSON.stringify({ 'Brand/500': '#6D28D9', 'Spacing/Gutter': 32 }));
    await useFigmaValue(dir, 'Brand/500');
    await useFigmaValue(dir, 'Spacing/Gutter');
    const tw = readFileSync(join(dir, 'tailwind.config.ts'), 'utf8');
    expect(tw).toContain('500: "#6d28d9",');
    expect(tw).toContain('spacing: { gutter: 32 },');
    await expect(useFigmaValue(dir, 'Brand/500')).rejects.toThrow(/already matches/);
    await expect(useFigmaValue(dir, 'Nope')).rejects.toThrow(/no longer paired/);
  });

  it('will not change a shared value for one mode, or a token that points at another', async () => {
    const dir = repo();
    await importVariables(dir, JSON.stringify({ variables: [
      { name: 'Color/Primary', value: '#2563EB', mode: 'Light' },
      { name: 'Color/Primary', value: '#93C5FD', mode: 'Dark' },
      { name: 'Color/Link', value: '#000000' },
    ] }));
    await expect(useFigmaValue(dir, 'Color/Primary@Dark')).rejects.toThrow(/no Dark override/);
    await expect(useFigmaValue(dir, 'Color/Link')).rejects.toThrow(/points at another token/);
  });
});
