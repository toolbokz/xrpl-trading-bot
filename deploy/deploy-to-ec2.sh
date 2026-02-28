#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Deploy script: sync bot code to EC2.
#
# Usage:
#   ./deploy/deploy-to-ec2.sh <EC2_HOST> [SSH_KEY]
#
# Example:
#   ./deploy/deploy-to-ec2.sh ec2-user@3.25.100.50 ~/.ssh/xrpl-bot.pem
#
# The script rsync's the project (excluding node_modules etc.),
# runs npm ci + build on the remote, then restarts the service.
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

EC2_HOST="${1:?Usage: $0 <EC2_HOST> [SSH_KEY]}"
SSH_KEY="${2:-}"
REMOTE_DIR="/opt/xrpl-trading-bot"

SSH_OPTS="-o StrictHostKeyChecking=accept-new"
if [ -n "$SSH_KEY" ]; then
    SSH_OPTS="$SSH_OPTS -i $SSH_KEY"
fi

echo "══════════════════════════════════════════════════════════"
echo " Deploying XRPL Trading Bot to $EC2_HOST"
echo "══════════════════════════════════════════════════════════"

# ── 1. Sync code ────────────────────────────────────────────
echo "→ Syncing project files..."
rsync -avz --progress \
    --exclude 'node_modules' \
    --exclude '.next' \
    --exclude 'dist' \
    --exclude 'data/*.sqlite*' \
    --exclude 'data/*.json' \
    --exclude '.env' \
    --exclude '.git' \
    --exclude 'coverage' \
    -e "ssh $SSH_OPTS" \
    ./ "${EC2_HOST}:${REMOTE_DIR}/"

# ── 2. Remote build ─────────────────────────────────────────
echo "→ Building on remote..."
ssh $SSH_OPTS "$EC2_HOST" bash -ls <<REMOTE
    set -euo pipefail
    cd "$REMOTE_DIR"

    echo "  npm ci..."
    npm ci --production 2>&1 | tail -5

    echo "  Building backend + frontend..."
    npm run build 2>&1 | tail -10

    echo "  Setting ownership..."
    sudo chown -R xrpl-bot:xrpl-bot "$REMOTE_DIR"
REMOTE

# ── 3. Restart service ──────────────────────────────────────
echo "→ Restarting service..."
ssh $SSH_OPTS "$EC2_HOST" "sudo systemctl restart xrpl-bot && sleep 2 && sudo systemctl is-active xrpl-bot"

echo ""
echo "══════════════════════════════════════════════════════════"
echo " Deployment complete! Service status: active"
echo ""
echo " Access dashboard:"
echo "   ssh $SSH_OPTS -L 3000:127.0.0.1:3000 $EC2_HOST"
echo "   → Open http://localhost:3000"
echo "══════════════════════════════════════════════════════════"
