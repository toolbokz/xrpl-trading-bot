/**
 * Custom Next.js server bound to localhost only (127.0.0.1).
 * 
 * SECURITY: This server ONLY listens on localhost, preventing any
 * remote network access to the trading bot dashboard.
 * 
 * Usage:
 *   node server.js
 *   # or via npm script: npm run dashboard
 */

const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const path = require('path');

// Security: Only bind to localhost
const HOSTNAME = '127.0.0.1';
const PORT = parseInt(process.env.PORT || '3000', 10);

// Resolve the UI directory for Next.js
const webDir = path.resolve(__dirname, 'src/ui');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev, dir: webDir });
const handle = app.getRequestHandler();

// Cloud platform detection (fail fast if deployed to cloud)
function detectCloudPlatform() {
    const envChecks = [
        { name: 'Vercel', vars: ['VERCEL', 'VERCEL_ENV', 'NOW_REGION'] },
        { name: 'AWS Lambda', vars: ['AWS_LAMBDA_FUNCTION_NAME', 'AWS_EXECUTION_ENV'] },
        { name: 'Google Cloud', vars: ['GOOGLE_CLOUD_PROJECT', 'GCP_PROJECT', 'GCLOUD_PROJECT', 'K_SERVICE'] },
        { name: 'Azure', vars: ['WEBSITE_SITE_NAME', 'AZURE_FUNCTIONS_ENVIRONMENT'] },
        { name: 'Heroku', vars: ['DYNO', 'HEROKU_APP_NAME'] },
        { name: 'Railway', vars: ['RAILWAY_STATIC_URL', 'RAILWAY_PROJECT_ID'] },
        { name: 'Render', vars: ['RENDER', 'RENDER_SERVICE_NAME'] },
        { name: 'Fly.io', vars: ['FLY_APP_NAME', 'FLY_REGION'] },
        { name: 'DigitalOcean App Platform', vars: ['DIGITALOCEAN_APP_NAME', 'DIGITALOCEAN_TOKEN'] },
        { name: 'Netlify', vars: ['NETLIFY', 'NETLIFY_BUILD_BASE'] },
        { name: 'Kubernetes', vars: ['KUBERNETES_SERVICE_HOST', 'KUBERNETES_PORT'] },
    ];

    for (const platform of envChecks) {
        for (const envVar of platform.vars) {
            if (process.env[envVar]) {
                return platform.name;
            }
        }
    }
    return null;
}

// Startup security check
function enforceLocalOnly() {
    const allowRemote = process.env.BOT_ALLOW_REMOTE === 'true';

    if (allowRemote) {
        console.warn('⚠️  WARNING: BOT_ALLOW_REMOTE=true - Remote access enabled (DANGEROUS)');
        return;
    }

    const cloudPlatform = detectCloudPlatform();
    if (cloudPlatform) {
        console.error(`🚫 SECURITY ERROR: Cloud platform detected: ${cloudPlatform}`);
        console.error('   This trading bot is locked to localhost execution only.');
        console.error('   Cloud deployment is BLOCKED to protect your funds.');
        console.error('');
        console.error('   If you understand the risks and want to override, set:');
        console.error('   BOT_ALLOW_REMOTE=true');
        process.exit(1);
    }
}

// Main startup
async function main() {
    console.log('🔒 Trading Bot Dashboard - Localhost Only Server');
    console.log('');

    // Security gate
    enforceLocalOnly();

    await app.prepare();

    const server = createServer(async (req, res) => {
        try {
            const parsedUrl = parse(req.url, true);
            await handle(req, res, parsedUrl);
        } catch (err) {
            console.error('Error handling request:', err);
            res.statusCode = 500;
            res.end('Internal Server Error');
        }
    });

    // CRITICAL: Only bind to localhost (127.0.0.1)
    server.listen(PORT, HOSTNAME, () => {
        console.log(`✅ Server listening on http://${HOSTNAME}:${PORT}`);
        console.log('');
        console.log('🔒 Security: Bound to localhost only - remote access is blocked');
        console.log('');
        if (dev) {
            console.log('📊 Development mode - open http://localhost:3000 in your browser');
        }
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
        console.log('Received SIGTERM, shutting down gracefully...');
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
    });

    process.on('SIGINT', () => {
        console.log('Received SIGINT, shutting down gracefully...');
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
    });
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
