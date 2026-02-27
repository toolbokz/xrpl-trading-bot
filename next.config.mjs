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
    webpack: (config, { isServer }) => {
        const originalEntry = config.entry;
        config.entry = async () => {
            const entries = typeof originalEntry === 'function'
                ? await originalEntry()
                : originalEntry;

            if (entries && typeof entries === 'object') {
                for (const key of Object.keys(entries)) {
                    if (key.includes('/__tests__/') || key.includes('.test.')) {
                        delete entries[key];
                    }
                }
            }

            return entries;
        };

        config.resolve.modules = [
            ...(config.resolve.modules || []),
            'node_modules',
        ];

        // Prevent Node-only native modules from being bundled in client builds.
        // better-sqlite3 is used by instrumentRegistry/db.ts (server-only).
        if (!isServer) {
            config.resolve.fallback = {
                ...config.resolve.fallback,
                fs: false,
            };
            config.externals = [
                ...(Array.isArray(config.externals) ? config.externals : []),
                'better-sqlite3',
            ];
        }

        return config;
    },
    // Trade streaming is served by Next.js API routes directly
    // (src/ui/pages/api/trades/stream.ts and src/ui/pages/api/trades/tape.ts).
    // Expose XRPL network to client-side for explorer link generation
    env: {
        NEXT_PUBLIC_XRPL_NETWORK: process.env.XRPL_NETWORK || 'mainnet',
    },
};

export default nextConfig;
