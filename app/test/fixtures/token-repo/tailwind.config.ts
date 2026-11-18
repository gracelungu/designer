import type { Config } from 'tailwindcss';
import defaultTheme from 'tailwindcss/defaultTheme';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#7c3aed', // purple
          500: "#8b5cf6",
        },
        danger: 'hsl(0, 84%, 60%)',
      },
      borderRadius: { pill: '9999px' },
      fontFamily: {
        display: ['Satoshi', ...defaultTheme.fontFamily.sans],
      },
      spacing: { gutter: 24 },
      screens: { xs: '420px' },
    },
  },
  plugins: [require('@tailwindcss/forms')],
} satisfies Config;
