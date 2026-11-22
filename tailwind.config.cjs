/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './vatsom_premium_oils.html',
    './admin-portal.html',
    './portfolio.html'
  ],
  theme: {
    extend: {
      colors: {
        obsidian: '#030303',
        paper: '#f4f1ea',
        paperDark: '#e5dec9',
        paperEdge: '#d6ccb2',
        charcoal: '#121212',
        accentGold: '#c5a059',
        goldBright: '#e5c67b',
        waxRed: '#7c1d1d',
        waxGlow: '#a82424'
      },
      fontFamily: {
        cinzel: ['Cinzel', 'serif'],
        sans: ['Plus Jakarta Sans', 'sans-serif'],
        serif: ['Playfair Display', 'serif'],
        mono: ['JetBrains Mono', 'monospace']
      }
    }
  },
  plugins: []
};
