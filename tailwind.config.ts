/**
 * Root Tailwind config — required because `next build` / `next dev`
 * run with CWD = project root, so Tailwind resolves content paths from here.
 */
import type { Config } from 'tailwindcss';

const config: Config = {
    darkMode: 'class',
    content: [
        './src/ui/app/**/*.{js,ts,jsx,tsx}',
        './src/ui/components/**/*.{js,ts,jsx,tsx}',
        './src/ui/pages/**/*.{js,ts,jsx,tsx}',
        './src/ui/app/globals.css',
    ],
    theme: {
        extend: {
            colors: {
                surface: '#0b1021',
                card: '#121933',
                accent: '#5dd0ff',
                success: '#35d399',
                danger: '#f87171',
            },
            boxShadow: {
                card: '0 10px 40px rgba(0,0,0,0.35)',
            },
            borderRadius: {
                xl2: '1.25rem',
            },
        },
    },
    plugins: [],
};

export default config;
