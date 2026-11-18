import { PriceCard } from './components/PriceCard';

const plans = [
  { plan: 'Starter', price: '$0', features: ['1 project', 'Community support', 'Basic analytics'] },
  { plan: 'Pro', price: '$24', highlighted: true, cta: 'Start free trial', features: ['Unlimited projects', 'Priority support', 'Advanced analytics', 'Custom domains'] },
  { plan: 'Team', price: '$79', cta: 'Talk to sales', features: ['Everything in Pro', 'SSO', 'Audit log', 'Shared libraries'] },
];

export function App() {
  return (
    <main style={{ padding: 'var(--space-8)', display: 'grid', gap: 'var(--space-8)', justifyItems: 'center' }}>
      <header style={{ textAlign: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--font-size-xl)' }}>Simple pricing for bright ideas</h1>
        <p style={{ color: 'var(--color-muted)', margin: 'var(--space-2) 0 0' }}>Start free. Upgrade when your team grows.</p>
      </header>
      <section style={{ display: 'flex', gap: 'var(--space-6)', flexWrap: 'wrap', justifyContent: 'center' }}>
        {plans.map((p) => (
          <PriceCard key={p.plan} {...p} />
        ))}
      </section>
    </main>
  );
}
