import type { Meta, StoryObj } from '@storybook/react-vite';
import { PriceCard } from './PriceCard';

const meta = {
  title: 'Components/PriceCard',
  component: PriceCard,
  args: { plan: 'Starter', price: '$0', features: ['1 project', 'Community support', 'Basic analytics'] },
} satisfies Meta<typeof PriceCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Highlighted: Story = { args: { plan: 'Pro', price: '$24', highlighted: true, cta: 'Start free trial', features: ['Unlimited projects', 'Priority support', 'Advanced analytics', 'Custom domains'] } };
