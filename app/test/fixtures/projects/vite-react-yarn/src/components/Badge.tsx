import { forwardRef } from 'react';
type BadgeProps = { tone?: 'info' | 'danger'; children: React.ReactNode };
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge({ tone = 'info', children }, ref) {
  return <span ref={ref} data-tone={tone}>{children}</span>;
});
