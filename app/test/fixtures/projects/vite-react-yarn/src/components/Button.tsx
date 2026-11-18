interface Props { children: React.ReactNode; disabled?: boolean }
export const Button = ({ children, disabled }: Props) => <button disabled={disabled}>{children}</button>;
