import type { ButtonHTMLAttributes } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
  size?: 'md' | 'lg';
}

export function Button({ variant = 'primary', size = 'md', style, ...rest }: ButtonProps) {
  const primary = variant === 'primary';
  return (
    <button
      {...rest}
      style={{
        appearance: 'none',
        border: `1px solid ${primary ? 'var(--color-primary)' : 'var(--color-border)'}`,
        background: primary ? 'var(--color-primary)' : 'var(--color-bg)',
        color: primary ? 'var(--color-primary-text)' : 'var(--color-text)',
        borderRadius: 'var(--radius-sm)',
        padding: size === 'lg' ? 'var(--space-3) var(--space-6)' : 'var(--space-2) var(--space-4)',
        fontFamily: 'var(--font-family)',
        fontSize: size === 'lg' ? 'var(--font-size-md)' : 'var(--font-size-sm)',
        fontWeight: 600,
        cursor: 'pointer',
        ...style,
      }}
    />
  );
}
