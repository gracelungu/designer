import type { ReactNode } from 'react';

export function Badge({ children, tone = 'accent' }: { children: ReactNode; tone?: 'accent' | 'success' }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px var(--space-2)',
        borderRadius: '999px',
        background: tone === 'accent' ? 'var(--color-accent)' : 'var(--color-success)',
        color: '#fff',
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.02em',
      }}
    >
      {children}
    </span>
  );
}
