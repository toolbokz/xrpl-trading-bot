/**
 * Root Tailwind config — required because `next build web` / `next dev web`
 * run with CWD = project root, so Tailwind resolves content paths from here.
 * Mirrors web/tailwind.config.ts with web/-prefixed content paths.
 */
import type { Config } from 'tailwindcss';

const config: Config = {
    darkMode: 'class',
    content: [
        './web/app/**/*.{js,ts,jsx,tsx}',
        './web/components/**/*.{js,ts,jsx,tsx}',
        './web/pages/**/*.{js,ts,jsx,tsx}',
        './web/app/globals.css',
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
