import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './Button';

const meta = { title: 'Components/Button', component: Button, args: { children: 'Start free trial' } } satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};
export const Secondary: Story = { args: { variant: 'secondary', children: 'Talk to sales' } };
export const Large: Story = { args: { size: 'lg' } };
