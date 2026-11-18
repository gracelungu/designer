export interface ButtonProps {
  label: string;
  variant?: 'primary' | 'secondary';
  size?:
    | 'sm'
    | 'md';
  onClick?: () => void;
}
export function Button({ label, variant = 'primary', size = 'md', onClick }: ButtonProps) {
  return <button className={`${variant} ${size}`} onClick={onClick}>{label}</button>;
}
