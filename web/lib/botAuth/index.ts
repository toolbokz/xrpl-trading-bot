/**
 * Bot API Authentication Module
 *
 * Provides HMAC-based authentication with:
 * - Signature verification
 * - Timestamp validation
 * - Nonce-based replay protection
 * - Rate limiting
 * - Role-based access control (RBAC)
 * - IP allowlist support
 * - Audit logging
 */

export { withBotAuth, type AuthenticatedRequest, type BotAuthOptions } from './withBotAuth';
export { type Permission, type Role, hasPermission, getPermissions } from './permissions';
export { loadBotAuthEnv, type ApiKey } from './env';
export { computeSignature, computeCanonical } from './hmac';
export { readRawBody, parseJsonBody } from './rawBody';
export { logAudit, generateRequestId } from './audit';
