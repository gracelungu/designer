import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalName,
  normalizeValue,
  parseColorValue,
  parseFigmaVariables,
  sameValue,
  summarize,
  syncTokens,
  toCodeValue,
  tokensForValue,
  type CodeToken,
} from '../src/shared/tokenSync';

const REST = readFileSync(join(__dirname, 'fixtures', 'token-repo', 'figma-variables.rest.json'), 'utf8');

const css = (name: string, value: string, selector = ':root', line = 1): CodeToken => ({ name, value, file: 'tokens.css', line, selector, kind: /color/.test(name) ? 'color' : 'size', source: 'css' });

describe('token names', () => {
  it('maps Figma, CSS and Tailwind spellings to one name', () => {
    expect(canonicalName('Color/Primary/500')).toBe('color-primary-500');
    expect(canonicalName('--color-primary-500')).toBe('color-primary-500');
    expect(canonicalName('colors.primary.500')).toBe('color-primary-500');
    expect(canonicalName('Colours/Primary 500')).toBe('color-primary-500');
    expect(canonicalName('borderRadius.card')).toBe('radius-card');
    expect(canonicalName('Spacing/4')).toBe('space-4');
    expect(canonicalName('colors.brand.DEFAULT')).toBe('color-brand');
    expect(canonicalName('fontFamily.body')).toBe('font-body');
  });
});

describe('token values', () => {
  it('reads colours in every CSS notation', () => {
    expect(parseColorValue('#2563eb')).toEqual([37, 99, 235, 1]);
    expect(parseColorValue('#fff')).toEqual([255, 255, 255, 1]);
    expect(parseColorValue('#00000080')?.[3]).toBeCloseTo(0.502, 2);
    expect(parseColorValue('rgb(37 99 235 / 50%)')).toEqual([37, 99, 235, 0.5]);
    expect(parseColorValue('rgba(37, 99, 235, 0.5)')).toEqual([37, 99, 235, 0.5]);
    expect(parseColorValue('hsl(0, 100%, 50%)')?.map(Math.round)).toEqual([255, 0, 0, 1]);
    expect(parseColorValue('white')).toEqual([255, 255, 255, 1]);
    expect(parseColorValue('var(--x)')).toBeNull();
  });
  it('compares Figma and code values the way a designer would', () => {
    expect(sameValue(normalizeValue({ r: 0.1450980392, g: 0.3882352941, b: 0.9215686275, a: 1 }), normalizeValue('#2563EB'))).toBe(true);
    expect(sameValue(normalizeValue(16), normalizeValue('1rem'))).toBe(true);
    expect(sameValue(normalizeValue('16'), normalizeValue('16px'))).toBe(true);
    expect(sameValue(normalizeValue(12), normalizeValue('8px'))).toBe(false);
    expect(sameValue(normalizeValue('Inter'), normalizeValue('"Inter", system-ui, sans-serif'))).toBe(true);
    expect(sameValue(normalizeValue('#2563eb'), normalizeValue('#2563ec'))).toBe(true); // within rounding
    expect(sameValue(normalizeValue('#2563eb'), normalizeValue('#2563f0'))).toBe(false);
  });
  it('writes a Figma value in the notation the code already uses', () => {
    expect(toCodeValue('#121214', '#0b0b0c')).toBe('#121214');
    expect(toCodeValue('#121214', '#FFF')).toBe('#121214');
    expect(toCodeValue('#12121480', 'rgb(0, 0, 0)')).toBe('rgba(18, 18, 20, 0.502)');
    expect(toCodeValue('12', '8px')).toBe('12px');
    expect(toCodeValue('20', '1rem')).toBe('1.25rem');
    expect(toCodeValue('24', '16')).toBe('24');
    expect(toCodeValue('Satoshi Variable', '"Inter", system-ui, sans-serif')).toBe('"Satoshi Variable", system-ui, sans-serif');
  });
});

describe('Figma variable files', () => {
  it('reads the REST API shape, with modes, aliases, and without remote variables', () => {
    const vars = parseFigmaVariables(REST);
    const names = vars.map((v) => `${v.name}${v.mode ? '@' + v.mode : ''}`);
    expect(names).toContain('Color/Surface@Light');
    expect(names).toContain('Color/Surface@Dark');
    expect(names).toContain('Color/Primary');
    expect(names).not.toContain('Remote/Thing');
    const link = vars.find((v) => v.name === 'Color/Link' && v.mode === 'Light')!;
    expect(link.value).toMatchObject({ r: 0.1450980392 });
    expect(link.collection).toBe('Theme');
  });
  it('reads the desktop server flat map', () => {
    const vars = parseFigmaVariables({ 'Color/Primary': '#2563EB', 'Space/4': '16' });
    expect(vars).toEqual([
      { name: 'Color/Primary', value: '#2563EB', type: 'COLOR' },
      { name: 'Space/4', value: '16', type: 'FLOAT' },
    ]);
  });
  it('reads W3C design tokens and Tokens Studio files, with aliases', () => {
    const dtcg = parseFigmaVariables({ color: { $type: 'color', blue: { 500: { $value: '#2563eb' } }, primary: { $value: '{color.blue.500}' } }, space: { 4: { $value: 16 } } });
    expect(dtcg.map((v) => [v.name, v.value])).toEqual([
      ['color/blue/500', '#2563eb'],
      ['color/primary', '#2563eb'],
      ['space/4', 16],
    ]);
    const studio = parseFigmaVariables({ global: { radius: { card: { value: '12', type: 'borderRadius' } } } });
    expect(studio).toEqual([{ name: 'global/radius/card', value: '12', type: 'FLOAT' }]);
  });
  it('refuses something that is not JSON variables', () => {
    expect(() => parseFigmaVariables('42')).toThrow();
    expect(() => parseFigmaVariables('{nope')).toThrow();
  });
});

describe('syncing Figma and code', () => {
  const code = [
    css('--color-primary', '#2563eb', ':root', 3),
    css('--color-surface', '#ffffff', ':root', 4),
    css('--color-link', 'var(--color-primary)', ':root', 5),
    css('--radius-card', '8px', ':root', 6),
    css('--legacy-gutter', '13px', ':root', 7),
    css('--color-surface', '#0b0b0c', '[data-theme="dark"]', 10),
  ];
  const pairs = syncTokens(parseFigmaVariables(REST), code);
  const get = (key: string) => pairs.find((p) => p.key === key)!;

  it('pairs by name and reports in sync, drift and one-sided tokens', () => {
    expect(get('Color/Primary')).toMatchObject({ status: 'in-sync', match: 'name', code: { name: '--color-primary' } });
    expect(get('Radius/Card')).toMatchObject({ status: 'drift', figma: { value: '12' }, code: { value: '8px' } });
    expect(get('Color/Success').status).toBe('figma-only');
    expect(pairs.find((p) => p.code?.name === '--legacy-gutter')!.status).toBe('code-only');
  });
  it('compares each Figma mode with its own selector', () => {
    expect(get('Color/Surface@Light')).toMatchObject({ status: 'in-sync', code: { selector: ':root' } });
    expect(get('Color/Surface@Dark')).toMatchObject({ status: 'drift', code: { selector: '[data-theme="dark"]' } });
  });
  it('follows var() references and aliases on both sides', () => {
    expect(get('Color/Link@Light')).toMatchObject({ status: 'in-sync', code: { resolved: '#2563eb' } });
    // No dark override in code: the base value is what dark mode shows.
    expect(get('Color/Link@Dark')).toMatchObject({ status: 'in-sync', code: { selector: ':root' } });
  });
  it('uses links the user made over name matching', () => {
    const linked = syncTokens([{ name: 'Old/Gutter', value: 13 }], code, { 'Old/Gutter': '--legacy-gutter' });
    expect(linked[0]).toMatchObject({ status: 'in-sync', match: 'linked', code: { name: '--legacy-gutter' } });
    expect(linked.some((p) => p.status === 'code-only' && p.code?.name === '--legacy-gutter')).toBe(false);
  });
  it('matches without the group name when only one token fits', () => {
    const r = syncTokens([{ name: 'Brand/500', value: '#8b5cf6' }], [{ ...css('colors.brand.500', '#8B5CF6'), source: 'tailwind', selector: 'tailwind theme' }]);
    expect(r[0]).toMatchObject({ status: 'in-sync', match: 'loose-name' });
  });
  it('prefers the token holding the value when Tailwind only points at a CSS variable', () => {
    const r = syncTokens([{ name: 'Color/Primary', value: '#000000' }], [css('--color-primary', '#2563eb'), { ...css('colors.primary', 'var(--color-primary)'), source: 'tailwind', selector: 'tailwind theme' }]);
    expect(r[0]).toMatchObject({ status: 'drift', code: { name: '--color-primary' } });
  });
  it('counts each status', () => {
    expect(summarize(pairs)).toEqual({ inSync: 4, drift: 2, figmaOnly: 4, codeOnly: 1 });
  });
  it('finds the tokens behind a raw value on a layer, drift first', () => {
    expect(tokensForValue('#2563EB', pairs, 'color').map((p) => p.key)).toEqual(['Color/Primary', 'Color/Link@Light']);
    expect(tokensForValue(12, pairs).map((p) => p.key)).toEqual(['Radius/Card']);
    expect(tokensForValue(8, pairs).map((p) => p.status)).toEqual(['drift']);
    expect(tokensForValue('#123456', pairs)).toEqual([]);
  });
});
