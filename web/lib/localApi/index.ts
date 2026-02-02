/**
 * Local-only API middleware module.
 * Simplified security for localhost-only bot execution.
 */

export { withLocalApi, isLocalRequest, jsonError } from './withLocalApi';
export type { LocalRequest, LocalApiConfig } from './types';
export { logAudit, logSensitiveAction } from './audit';
