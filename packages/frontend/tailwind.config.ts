import type { Config } from 'tailwindcss';
import typography from '@tailwindcss/typography';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      keyframes: {
        /* Lifecycle tracker: bouncy heartbeat on current station */
        'heartbeat-scale': {
          '0%':   { transform: 'scale(1)' },
          '16%':  { transform: 'scale(1.28)' },
          '26%':  { transform: 'scale(1.19)' },
          '34%':  { transform: 'scale(1.24)' },
          '60%':  { transform: 'scale(1)' },
          '100%': { transform: 'scale(1)' },
        },
        /* Lifecycle tracker: shimmer flowing along completed tracks */
        'shimmer-flow': {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        /* Lifecycle tracker: vertical shimmer for branch stems */
        'shimmer-vertical': {
          '0%':   { backgroundPosition: '0 -200%' },
          '100%': { backgroundPosition: '0 200%' },
        },
        /* Launcher tile: glow on highlighted items */
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(247, 151, 36, 0.3)' },
          '50%': { boxShadow: '0 0 12px 4px rgba(247, 151, 36, 0.15)' },
        },
        'slide-in-right': {
          '0%': { transform: 'translateX(100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'slide-in-right': 'slide-in-right 0.25s ease-out',
      },
      fontFamily: {
        lexend: ['var(--font-lexend)', 'sans-serif'],
        mulish: ['var(--font-mulish)', 'sans-serif'],
        sans: ['var(--font-mulish)', 'sans-serif'],
      },
      colors: {
        /* Semantic surface tokens — swap via CSS variables in globals.css.
           Use these for backgrounds/borders that represent layered UI
           surfaces so dark-mode contrast can be retuned centrally. */
        'surface-base':    'rgb(var(--surface-base) / <alpha-value>)',
        'surface-raised':  'rgb(var(--surface-raised) / <alpha-value>)',
        'surface-overlay': 'rgb(var(--surface-overlay) / <alpha-value>)',
        'border-subtle':   'rgb(var(--border-subtle) / <alpha-value>)',
        'border-default':  'rgb(var(--border-default) / <alpha-value>)',
        'input-bg':        'rgb(var(--input-bg) / <alpha-value>)',
        corp: {
          dark: '#252422',
          blue: '#149FD8',
          'blue-light': '#5CBEE6',   /* lighter sky shade for early-phase statuses */
          'blue-dark':  '#0F7DAA',   /* deeper ocean shade for late-phase statuses */
          teal: '#3ECDBC',
          'teal-bright': '#6FDED0',  /* dark-mode text token, AA against #141414 */
          green: '#97D33F',
          'green-dark': '#7AB228',   /* darker shade to distinguish done vs approved */
          yellow: '#FCCB30',
          'yellow-bright': '#FFE066', /* dark-mode text token, AA against #141414 */
          orange: '#F79724',
          red: '#EE481D'
        },
        /*
         * `accent-*` — primary brand accent (Tailwind orange-600 scale).
         * Use for primary action buttons, active tab underlines, highlighted
         * icons, focus rings, and link text. On light surfaces prefer the
         * `accent-700` shade for text (WCAG AA); the `DEFAULT` (`orange-600`)
         * is intended for filled backgrounds, icons, and large focus rings.
         * Change the brand accent in one place by updating this scale.
         */
        accent: {
          DEFAULT: '#EA580C',
          hover: '#C2410C',
          ring: '#EA580C',
          light: 'rgba(234, 88, 12, 0.1)',
          50: '#FFF7ED',
          100: '#FFEDD5',
          200: '#FED7AA',
          300: '#FDBA74',
          400: '#FB923C',
          500: '#F97316',
          600: '#EA580C',
          700: '#C2410C',
          800: '#9A3412',
          900: '#7C2D12',
          950: '#431407',
        },
        /**
         * secondary-* — Indigo palette used intentionally for semantic type-chips
         * and badges (precedent, guideline, manual-track, AI-run, knowledge-type).
         * NOT a primary brand color. Primary brand is `accent-*` (orange). If you
         * need a brand-primary affordance (button, active-tab, focus-ring), use
         * `accent-*`, not `secondary-*`. This token was previously named
         * `arbitra-*` which caused recurring drift.
         */
        secondary: {
          50:  '#EDF1FD',
          100: '#D6DFFB',
          200: '#ADBFF7',
          300: '#849FF3',
          400: '#5B7FEF',
          500: '#446CE4',
          600: '#2952CC',
          700: '#1F3E99',
          800: '#152A66',
          900: '#0B1533',
          950: '#060B1A',
        },
      },
    },
  },
  plugins: [typography],
};

export default config;
