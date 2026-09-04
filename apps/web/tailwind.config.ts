import type { Config } from 'tailwindcss';

/**
 * SNAPX design tokens (spec §3), named semantically rather than by colour so a
 * future theme is a token swap instead of a find-and-replace.
 */
export default {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './features/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand:   { DEFAULT: '#FFE500', dim: '#D6C000', ink: '#080808' },
        bg:      '#080808',
        surface: { DEFAULT: '#151515', 2: '#202020', 3: '#2A2A2A' },
        ink:     { DEFAULT: '#FFFFFF', dim: '#A7A7A7', faint: '#6B6B6B' },
        line:    '#2A2A2A',
        ok:      '#22C55E',
        danger:  '#FF4D4F',
        warn:    '#F59E0B',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Inter', 'Segoe UI',
               'Roboto', 'Helvetica Neue', 'system-ui', 'sans-serif'],
      },
      borderRadius: { xl: '14px', '2xl': '20px', '3xl': '28px' },
      boxShadow: {
        glow: '0 0 0 1px rgba(255,229,0,0.30), 0 8px 32px -8px rgba(255,229,0,0.35)',
        lift: '0 12px 32px -12px rgba(0,0,0,0.9)',
      },
      keyframes: {
        'pulse-rec': { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.25' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
      animation: { 'pulse-rec': 'pulse-rec 1.2s ease-in-out infinite' },
    },
  },
  plugins: [],
} satisfies Config;
