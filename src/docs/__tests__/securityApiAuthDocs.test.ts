import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readRepoFile(relativePath: string): string {
    return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('security auth documentation drift checks', () => {
    it('keeps LOCAL_API_TOKEN documented in security doc and env examples', () => {
        const securityDoc = readRepoFile('docs/security-api-auth.md');
        const envExamplePaths = ['.env.example', '.env.example.development']
            .filter((candidatePath) => fs.existsSync(path.resolve(process.cwd(), candidatePath)));

        expect(securityDoc).toContain('LOCAL_API_TOKEN');
        expect(securityDoc).toContain('HMAC API signing is not implemented.');
        expect(securityDoc).toContain('RBAC permission enforcement is not implemented.');

        expect(envExamplePaths.length).toBeGreaterThan(0);
        for (const envExamplePath of envExamplePaths) {
            const envExample = readRepoFile(envExamplePath);
            expect(envExample).toContain('LOCAL_API_TOKEN');
        }
    });
});
