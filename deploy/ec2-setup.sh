#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# EC2 instance setup script for the XRPL Trading Bot.
#
# Run once on a fresh Amazon Linux 2023 / Ubuntu 22.04 EC2 instance:
#   chmod +x deploy/ec2-setup.sh && sudo ./deploy/ec2-setup.sh
#
# After setup, deploy the bot code and start the service:
#   sudo systemctl start xrpl-bot
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_USER="xrpl-bot"
APP_DIR="/opt/xrpl-trading-bot"
NODE_VERSION="20"

echo "══════════════════════════════════════════════════════════"
echo " XRPL Trading Bot — EC2 Instance Setup"
echo "══════════════════════════════════════════════════════════"

# ── 1. Detect OS ─────────────────────────────────────────────
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    OS="unknown"
fi
echo "Detected OS: $OS"

# ── 2. Install Node.js 20 LTS ───────────────────────────────
install_node_amzn() {
    curl -fsSL https://rpm.nodesource.com/setup_${NODE_VERSION}.x | bash -
    yum install -y nodejs
}

install_node_ubuntu() {
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
}

if ! command -v node &>/dev/null || [[ "$(node -v)" != v${NODE_VERSION}* ]]; then
    echo "Installing Node.js ${NODE_VERSION}..."
    case "$OS" in
        amzn|fedora|rhel|centos)
            install_node_amzn
            ;;
        ubuntu|debian)
            install_node_ubuntu
            ;;
        *)
            echo "Unsupported OS: $OS. Install Node.js $NODE_VERSION manually."
            exit 1
            ;;
    esac
fi
echo "Node.js version: $(node -v)"
echo "npm version:     $(npm -v)"

# ── 3. Install build tools (for better-sqlite3 native addon) ─
case "$OS" in
    amzn|fedora|rhel|centos)
        yum groupinstall -y "Development Tools" 2>/dev/null || yum install -y gcc gcc-c++ make python3
        ;;
    ubuntu|debian)
        apt-get update -y && apt-get install -y build-essential python3
        ;;
esac

# ── 4. Create application user and directory ─────────────────
if ! id "$APP_USER" &>/dev/null; then
    useradd -r -s /usr/sbin/nologin -d "$APP_DIR" "$APP_USER"
    echo "Created system user: $APP_USER"
fi

mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── 5. Install systemd service ──────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/xrpl-bot.service" ]; then
    cp "$SCRIPT_DIR/xrpl-bot.service" /etc/systemd/system/xrpl-bot.service
    systemctl daemon-reload
    systemctl enable xrpl-bot
    echo "Installed and enabled systemd service: xrpl-bot"
else
    echo "⚠  xrpl-bot.service not found in $SCRIPT_DIR — install it manually."
fi

# ── 6. CloudWatch agent (optional) ──────────────────────────
if command -v amazon-cloudwatch-agent-ctl &>/dev/null; then
    echo "CloudWatch agent already installed."
elif [ "$OS" = "amzn" ]; then
    yum install -y amazon-cloudwatch-agent 2>/dev/null || true
    echo "CloudWatch agent installed (configure via /opt/aws/amazon-cloudwatch-agent/)."
else
    echo "CloudWatch agent skipped (not Amazon Linux). Install manually if needed."
fi

echo ""
echo "══════════════════════════════════════════════════════════"
echo " Setup complete!"
echo ""
echo " Next steps:"
echo "  1. Deploy bot code to $APP_DIR (rsync / git clone / CodeDeploy)"
echo "  2. Copy .env to $APP_DIR/.env (or use AWS Secrets Manager)"
echo "  3. cd $APP_DIR && npm ci --production && npm run build"
echo "  4. sudo systemctl start xrpl-bot"
echo "  5. Access dashboard via SSH tunnel: ssh -L 3000:127.0.0.1:3000 ec2-user@<ip>"
echo "══════════════════════════════════════════════════════════"
