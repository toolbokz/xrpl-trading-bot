# Secret Rotation Procedure for BOT_API_KEYS

This document describes the procedure for rotating API keys used in the XRPL Trading Bot's authentication system.

## Overview

The bot uses HMAC-based API key authentication. Each API key consists of:
- **ID**: A unique identifier (minimum 6 characters)
- **Secret**: A hex-encoded secret key (minimum 32 characters, recommended 64)
- **Role**: Permission level (`admin`, `operator`, or `readonly`)
- **Optional**: Description and IP allowlist

API keys are stored in the `BOT_API_KEYS` environment variable as a JSON array.

## When to Rotate Keys

Rotate API keys when:
1. A key is suspected to be compromised
2. An employee with key access leaves the organization
3. As part of regular security hygiene (recommended: every 90 days)
4. After a security incident or audit finding

## Pre-Rotation Checklist

Before rotating keys:

- [ ] Identify all systems/clients using the key to be rotated
- [ ] Prepare new key values (generate secure secrets)
- [ ] Schedule a maintenance window if needed
- [ ] Notify affected teams/services
- [ ] Test the new key in a staging environment

## Key Generation

### Generate a Secure Secret

Use a cryptographically secure random generator:

```bash
# Generate a 64-character hex secret (256 bits)
openssl rand -hex 32

# Or using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Example Key Structure

```json
{
  "id": "admin-key-2024-01",
  "secret": "a3f8c9d2e1b4a5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0",
  "role": "admin",
  "description": "Admin key for production - rotated Jan 2024",
  "allowedIps": ["10.0.0.0/8", "192.168.1.0/24"]
}
```

## Rotation Procedures

### Procedure A: Zero-Downtime Rotation (Recommended)

This procedure allows for seamless key rotation without service interruption.

#### Step 1: Add New Key (Keep Old Key Active)

Update `BOT_API_KEYS` to include both old and new keys:

```bash
# Current:
BOT_API_KEYS='[{"id":"admin-key-old","secret":"...old-secret...","role":"admin"}]'

# Updated (both keys active):
BOT_API_KEYS='[
  {"id":"admin-key-old","secret":"...old-secret...","role":"admin"},
  {"id":"admin-key-new","secret":"...new-secret...","role":"admin","description":"Rotated 2024-01-15"}
]'
```

#### Step 2: Deploy Configuration

Deploy the updated environment variable:

```bash
# If using Docker
docker service update --env-add 'BOT_API_KEYS=...' trading-bot

# If using Kubernetes
kubectl set env deployment/trading-bot BOT_API_KEYS='...'

# If using systemd
# Edit /etc/trading-bot/.env and restart
sudo systemctl restart trading-bot
```

#### Step 3: Update Clients

Update all clients/services to use the new key:

```typescript
// Example client configuration update
const apiClient = new TradingBotClient({
  apiKeyId: 'admin-key-new',  // Updated
  apiKeySecret: '...new-secret...',  // Updated
});
```

#### Step 4: Verify New Key Works

Test the new key:

```bash
# Test authentication with new key
curl -X GET \
  -H "X-API-KEY: admin-key-new" \
  -H "X-TIMESTAMP: $(date +%s)" \
  -H "X-NONCE: $(openssl rand -hex 16)" \
  -H "X-SIGNATURE: $(echo -n "..." | openssl dgst -sha256 -hmac "...new-secret...")" \
  https://your-bot.example.com/api/bot/status
```

#### Step 5: Remove Old Key

After confirming all clients have migrated:

```bash
# Final configuration with only new key:
BOT_API_KEYS='[{"id":"admin-key-new","secret":"...new-secret...","role":"admin"}]'
```

### Procedure B: Emergency Rotation (Key Compromise)

If a key is compromised, immediate rotation is required:

#### Step 1: Immediately Disable Compromised Key

Remove the compromised key from `BOT_API_KEYS`:

```bash
# Remove compromised key immediately
# Keep only non-compromised keys active
```

#### Step 2: Generate and Deploy New Key

```bash
# Generate new secret
NEW_SECRET=$(openssl rand -hex 32)

# Deploy immediately
```

#### Step 3: Update All Clients

Update clients as quickly as possible, accepting brief service interruption if necessary.

#### Step 4: Audit and Investigate

1. Check audit logs for unauthorized access:
   ```bash
   grep "compromised-key-id" /var/log/trading-bot/audit.log
   ```

2. Review recent transactions for anomalies

3. Document the incident

## Audit Logging

All API key usage is logged to the audit log. After rotation, verify:

1. **Old key is no longer being used:**
   ```bash
   # Should return no recent entries after migration
   grep "admin-key-old" /var/log/trading-bot/audit.log | tail -20
   ```

2. **New key is working correctly:**
   ```bash
   # Should show successful authentications
   grep "admin-key-new" /var/log/trading-bot/audit.log | grep "success" | tail -20
   ```

## Key Lifecycle Best Practices

### Naming Convention

Use a consistent naming convention for key IDs:

```
{role}-{purpose}-{date}
```

Examples:
- `admin-production-2024-01`
- `operator-ci-cd-2024-01`
- `readonly-monitoring-2024-01`

### Key Inventory

Maintain an inventory of all active keys:

| Key ID | Role | Purpose | Created | Last Rotated | Next Rotation |
|--------|------|---------|---------|--------------|---------------|
| admin-production-2024-01 | admin | Production admin access | 2024-01-15 | 2024-01-15 | 2024-04-15 |
| operator-ci-cd-2024-01 | operator | CI/CD pipeline | 2024-01-15 | 2024-01-15 | 2024-04-15 |

### Rotation Schedule

| Role | Rotation Frequency | Grace Period |
|------|-------------------|--------------|
| admin | 90 days | 7 days |
| operator | 90 days | 7 days |
| readonly | 180 days | 14 days |

## Environment-Specific Considerations

### Development

- Use separate keys for development environments
- Rotate more frequently (30 days recommended)
- Never use production keys in development

### Staging

- Mirror production key rotation schedule
- Test rotation procedures here first
- Use staging to validate client updates

### Production

- Follow the zero-downtime procedure
- Document all rotations
- Maintain audit trail

## Troubleshooting

### Common Issues

1. **"Invalid API key" after rotation**
   - Verify the new key is correctly formatted in `BOT_API_KEYS`
   - Check for JSON syntax errors
   - Ensure the key ID matches exactly

2. **"Request timestamp expired" errors**
   - Client may be using outdated signature
   - Verify client is generating fresh timestamps

3. **Rate limiting during migration**
   - Old and new keys share rate limits by IP
   - Consider temporarily increasing limits during migration

### Validation Commands

```bash
# Validate JSON format
echo $BOT_API_KEYS | jq .

# Check key count
echo $BOT_API_KEYS | jq 'length'

# List all key IDs
echo $BOT_API_KEYS | jq '.[].id'
```

## Security Considerations

1. **Never log secrets** - Only log key IDs, never secret values
2. **Use secure channels** - Transmit new keys via encrypted channels only
3. **Principle of least privilege** - Only grant necessary permissions
4. **Separate keys by environment** - Never share keys across environments
5. **Monitor for unauthorized use** - Set up alerts for failed authentications

## Compliance

For compliance requirements (SOC 2, PCI-DSS, etc.):

1. Document all key rotations with timestamps
2. Maintain evidence of rotation procedures
3. Keep rotation logs for required retention period
4. Include key rotation in security policies

## Related Documentation

- [Authentication Architecture](./authentication.md)
- [RBAC Permissions](./permissions.md)
- [Audit Logging](./audit-logging.md)
- [Incident Response](./incident-response.md)
