/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    experimental: {
        externalDir: true,
    },
    // Ensure webpack resolves modules from root node_modules
    webpack: (config) => {
        config.resolve.modules = [
            ...(config.resolve.modules || []),
            '../node_modules',
        ];
        return config;
    },
    // Proxy trade stream endpoints to backend HTTP server
    async rewrites() {
        const backendPort = process.env.BACKEND_HTTP_PORT || 4000;
        const backendUrl = `http://127.0.0.1:${backendPort}`;
        return [
            {
                source: '/api/trades/stream',
                destination: `${backendUrl}/trades/stream`,
            },
            {
                source: '/api/trades/tape',
                destination: `${backendUrl}/trades/tape`,
            },
        ];
    },
};

export default nextConfig;
