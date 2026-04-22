/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // OSOD palette — dark space theme for Director view
        bg: {
          deep: "#0a0b14",
          mid: "#11131f",
          panel: "#1a1d2e",
        },
        orbital: {
          normal: "#6ee7b7",  // calm green (PERRL, no findings)
          caution: "#fbbf24", // amber (pending, recall due)
          alert: "#ef4444",   // red (active problem)
          quest: "#f59e0b",   // gold (task/quest available)
          info: "#60a5fa",    // blue (info, recent imaging)
        },
      },
      fontFamily: {
        display: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
