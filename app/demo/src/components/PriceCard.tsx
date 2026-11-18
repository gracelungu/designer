import { Badge } from './Badge';
import { Button } from './Button';

export interface PriceCardProps {
  plan: string;
  price: string;
  period?: string;
  features: string[];
  highlighted?: boolean;
  cta?: string;
}

export function PriceCard({ plan, price, period = '/month', features, highlighted = false, cta = 'Choose plan' }: PriceCardProps) {
  return (
    <article
      style={{
        width: 280,
        boxSizing: 'border-box',
        padding: 'var(--space-6)',
        borderRadius: 'var(--radius-lg)',
        border: `1px solid ${highlighted ? 'var(--color-primary)' : 'var(--color-border)'}`,
        background: 'var(--color-bg)',
        boxShadow: highlighted ? 'var(--shadow-card)' : 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 'var(--font-size-lg)' }}>{plan}</h3>
        {highlighted && <Badge>Most popular</Badge>}
      </header>
      <p style={{ margin: 0 }}>
        <span style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700 }}>{price}</span>
        <span style={{ color: 'var(--color-muted)', fontSize: 'var(--font-size-sm)' }}>{period}</span>
      </p>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 'var(--space-2)', fontSize: 'var(--font-size-sm)' }}>
        {features.map((f) => (
          <li key={f}>✓ {f}</li>
        ))}
      </ul>
      <Button variant={highlighted ? 'primary' : 'secondary'}>{cta}</Button>
    </article>
  );
}
