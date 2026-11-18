import { describe, expect, it } from 'vitest';
import { parseTokens, replaceTokenValue, tokenKind } from '../src/server/tokens';

const css = `/* brand */
:root {
  --color-primary: #2563eb;
  --space-4: 16px;
  --font-body: "Inter", sans-serif;
}
@theme {
  --radius-card: 8px;
}
[data-theme="dark"] { --color-primary: #60a5fa; }
.card { padding: var(--space-4); }
`;

describe('tokens', () => {
  it('finds custom properties with their line and selector', () => {
    const t = parseTokens(css, 'styles.css');
    expect(t.map((x) => [x.name, x.value, x.line, x.selector])).toEqual([
      ['--color-primary', '#2563eb', 3, ':root'],
      ['--space-4', '16px', 4, ':root'],
      ['--font-body', '"Inter", sans-serif', 5, ':root'],
      ['--radius-card', '8px', 8, '@theme'],
      ['--color-primary', '#60a5fa', 10, '[data-theme="dark"]'],
    ]);
  });
  it('classifies tokens', () => {
    expect(tokenKind('--brand', '#fff')).toBe('color');
    expect(tokenKind('--gap', '1rem')).toBe('size');
    expect(tokenKind('--font-body', 'Inter')).toBe('font');
    expect(tokenKind('--shadow-sm', '0 1px 2px #0002')).toBe('shadow');
  });
  it('rewrites only that declaration', () => {
    const out = replaceTokenValue(css, 3, '--color-primary', '#111111');
    expect(out).toContain('--color-primary: #111111;');
    expect(out).toContain('--color-primary: #60a5fa;');
    expect(out.split('\n').length).toBe(css.split('\n').length);
  });
  it('refuses a stale or unsafe edit', () => {
    expect(() => replaceTokenValue(css, 4, '--color-primary', 'red')).toThrow(/no longer/);
    expect(() => replaceTokenValue(css, 3, '--color-primary', 'red; } body {')).toThrow();
  });
});
