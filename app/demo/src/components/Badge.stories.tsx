import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge } from './Badge';

const meta = { title: 'Components/Badge', component: Badge, args: { children: 'Most popular' } } satisfies Meta<typeof Badge>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Accent: Story = {};
export const Success: Story = { args: { tone: 'success', children: 'Save 20%' } };
