/** @type {import('tailwindcss').Config} */
const config = {
    darkMode: 'class',
    // Scan all frontend sources for Tailwind class usage.
    content: [
        './web/app/**/*.{js,ts,jsx,tsx}',
        './web/components/**/*.{js,ts,jsx,tsx}',
        './web/pages/**/*.{js,ts,jsx,tsx}',
        './web/app/globals.css',
        './web/globals.css',
    ],
    theme: {
        extend: {
            colors: {
                // Base surfaces used across the dashboard shell.
                surface: '#0b1021',
                card: '#121933',
                accent: '#5dd0ff',
                success: '#35d399',
                danger: '#f87171',
            },
            boxShadow: {
                // Soft shadow to lift cards off the dark background.
                card: '0 10px 40px rgba(0,0,0,0.35)',
            },
            borderRadius: {
                xl2: '1.25rem',
            },
        },
    },
    plugins: [],
};

module.exports = config;
