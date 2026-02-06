/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    experimental: {
        externalDir: true,
    },
    // Use the dedicated UI tsconfig for Next.js compilation
    typescript: {
        tsconfigPath: '../../tsconfig.web.json',
    },
    // Ensure webpack resolves modules from root node_modules
    webpack: (config) => {
        config.resolve.modules = [
            ...(config.resolve.modules || []),
            'node_modules',
        ];
        return config;
    },
    // Trade streaming is served by Next.js API routes directly
    // (src/ui/pages/api/trades/stream.ts and src/ui/pages/api/trades/tape.ts).
};

export default nextConfig;
