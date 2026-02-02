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
};

export default nextConfig;
