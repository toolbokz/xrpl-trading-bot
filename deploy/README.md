# AWS Deployment Guide

Deploy the XRPL Trading Bot to an EC2 instance with secrets stored in AWS Secrets Manager.

## Architecture

```
┌────────────────────────────────────────────────────┐
│  Your Machine                                      │
│  ssh -L 3000:127.0.0.1:3000 ec2-user@<ip>        │
│  → http://localhost:3000 (dashboard)               │
└──────────────────┬─────────────────────────────────┘
                   │ SSH tunnel (port 3000)
                   ▼
┌────────────────────────────────────────────────────┐
│  EC2 Instance (t3.small)                           │
│  ┌──────────────────────────────────────────────┐  │
│  │  systemd: xrpl-bot.service                   │  │
│  │  → node server.js (127.0.0.1:3000)           │  │
│  │    ├─ Next.js dashboard                      │  │
│  │    └─ Trading runtime                        │  │
│  └──────────────┬───────────────┬───────────────┘  │
│                 │               │                   │
│                 ▼               ▼                   │
│       AWS Secrets Manager    XRPL WebSocket         │
│  (wallet credentials)    (s1.ripple.com:443)       │
└────────────────────────────────────────────────────┘
```

The bot binds to `127.0.0.1` — **no remote dashboard access**. You access it through an SSH tunnel, which keeps the localhost-only security model intact.

## Quick Start

### 1. Create the AWS infrastructure

**Option A: CloudFormation (recommended)**

```bash
aws cloudformation create-stack \
  --stack-name xrpl-trading-bot \
  --template-body file://deploy/cloudformation.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters \
    ParameterKey=KeyPairName,ParameterValue=your-key-pair \
    ParameterKey=VpcId,ParameterValue=vpc-xxxxx \
    ParameterKey=SubnetId,ParameterValue=subnet-xxxxx \
    ParameterKey=AllowedSshCidr,ParameterValue="$(curl -s ifconfig.me)/32" \
    ParameterKey=InstanceType,ParameterValue=t3.small
```

**Option B: Manual setup**

1. Launch an EC2 instance (Amazon Linux 2023, t3.small, 30GB gp3)
2. Attach an IAM role with the policy from `deploy/iam-policy.json`
3. Security group: SSH (22) from your IP only, outbound 443 for XRPL WebSocket
4. SSH in and run: `sudo ./deploy/ec2-setup.sh`

### 2. Store wallet credentials in Secrets Manager

```bash
aws secretsmanager create-secret \
  --name xrpl-trading-bot/wallet \
  --secret-string '{
    "XRPL_SECRET_NUMBERS_MAINNET_ENC": "<your-encrypted-secret-numbers>",
    "XRPL_SECRET_PASSPHRASE": "<your-passphrase>"
  }'
```

Or for a plain seed:

```bash
aws secretsmanager create-secret \
  --name xrpl-trading-bot/wallet \
  --secret-string '{"XRPL_SEED_MAINNET": "sYourSeedHere"}'
```

### 3. Deploy the bot code

```bash
# From your local machine:
./deploy/deploy-to-ec2.sh ec2-user@<EC2_IP> ~/.ssh/your-key.pem
```

Or manually:

```bash
# SSH to the instance
ssh -i ~/.ssh/your-key.pem ec2-user@<EC2_IP>

# Clone and build
cd /opt/xrpl-trading-bot
git clone <your-repo> .
cp deploy/.env.aws .env      # Edit with your trading params
npm ci --production
npm run build

# Start
sudo systemctl start xrpl-bot
sudo systemctl status xrpl-bot
```

### 4. Access the dashboard

```bash
# Open SSH tunnel
ssh -L 3000:127.0.0.1:3000 -i ~/.ssh/your-key.pem ec2-user@<EC2_IP>

# Now open in browser:
# http://localhost:3000
```

## Secrets Manager Configuration

The bot loads credentials from AWS Secrets Manager when `AWS_SECRET_NAME` is set in `.env`. The secret must be a JSON object with one or more of these keys:

| Key | Description |
|-----|-------------|
| `XRPL_SECRET_NUMBERS_MAINNET_ENC` | Encrypted secret numbers (preferred) |
| `XRPL_SECRET_PASSPHRASE` | Passphrase for encrypted secret numbers |
| `XRPL_SEED_MAINNET` | Mainnet family seed (s...) |
| `XRPL_SECRET_MAINNET` | Mainnet secret key |
| `XRPL_SECRET_NUMBERS_MAINNET` | Plaintext secret numbers |
| `KMS_KEY_ID` | AWS KMS key ID (for KMS signer) |

**Security notes:**
- The EC2 instance role needs `secretsmanager:GetSecretValue` permission
- Local `.env` values take precedence over Secrets Manager values
- Secrets are fetched once at startup, not cached or refreshed

## Operations

### Service management

```bash
sudo systemctl start xrpl-bot
sudo systemctl stop xrpl-bot
sudo systemctl restart xrpl-bot
sudo systemctl status xrpl-bot
```

### View logs

```bash
# Live tail
sudo journalctl -u xrpl-bot -f

# Last 100 lines
sudo journalctl -u xrpl-bot -n 100

# Since last boot
sudo journalctl -u xrpl-bot -b
```

### Rotate wallet secret

```bash
# Update the secret in Secrets Manager
aws secretsmanager update-secret \
  --secret-id xrpl-trading-bot/wallet \
  --secret-string '{"XRPL_SEED_MAINNET": "sNewSeedHere"}'

# Restart the bot to pick up the new secret
sudo systemctl restart xrpl-bot
```

### Update bot code

```bash
# From local machine:
./deploy/deploy-to-ec2.sh ec2-user@<EC2_IP> ~/.ssh/your-key.pem

# Or manually on the instance:
cd /opt/xrpl-trading-bot
git pull
npm ci --production
npm run build
sudo systemctl restart xrpl-bot
```

## Cost Estimate

| Resource | Monthly Cost (ap-southeast-2) |
|----------|-------------------------------|
| t3.small (24/7) | ~$15 |
| 30GB gp3 EBS | ~$2.50 |
| Secrets Manager (1 secret) | ~$0.40 |
| Data transfer (XRPL WebSocket) | ~$1-5 |
| **Total** | **~$20-25/month** |

## Security Checklist

- [ ] SSH key pair stored securely (not committed to git)
- [ ] Security group limits SSH to your IP only (not 0.0.0.0/0)
- [ ] Wallet credentials stored in Secrets Manager, not in `.env`
- [ ] No plaintext seeds in EC2 user data or instance metadata
- [ ] EBS volume encrypted (default in CloudFormation template)
- [ ] IAM role follows least privilege (only `secretsmanager:GetSecretValue`)
- [ ] Dashboard accessed via SSH tunnel only (bot binds to 127.0.0.1)
- [ ] `MAINNET_LIVE_TRADING_ACK=true` set intentionally
