/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // bootCAN custom color palette
        can: {
          bg: {
            primary: "#0d1117",
            secondary: "#161b22",
            tertiary: "#21262d",
            hover: "#30363d",
          },
          border: {
            DEFAULT: "#30363d",
            muted: "#21262d",
          },
          text: {
            primary: "#e6edf3",
            secondary: "#8b949e",
            muted: "#6e7681",
          },
          accent: {
            green: "#3fb950",
            red: "#f85149",
            yellow: "#d29922",
            blue: "#58a6ff",
            purple: "#a371f7",
            orange: "#db6d28",
          },
        },
      },
      fontFamily: {
        mono: [
          "JetBrains Mono",
          "Fira Code",
          "Monaco",
          "Consolas",
          "monospace",
        ],
        sans: [
          "IBM Plex Sans",
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "sans-serif",
        ],
      },
      fontSize: {
        xxs: "0.625rem",
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "fade-in": "fadeIn 0.2s ease-out",
        "slide-up": "slideUp 0.3s ease-out",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};

