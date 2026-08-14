import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}", "./components/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b0f14",
        surface: "#131a21",
        surface2: "#1b2530",
        border: "#26323d",
        accent: "#22c55e",
        danger: "#ef4444",
        muted: "#8b98a5",
      },
    },
  },
  plugins: [],
};

export default config;
