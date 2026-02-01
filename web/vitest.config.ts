import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['lib/**/__tests__/**/*.test.ts'],
        exclude: ['node_modules', '.next'],
        globals: true,
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, '.'),
        },
    },
});
