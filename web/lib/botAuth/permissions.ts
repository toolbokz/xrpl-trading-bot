/**
 * RBAC permissions for bot API.
 */

export type Role = 'admin' | 'operator' | 'readonly';

export type Permission =
    | 'bot:run'
    | 'bot:pause'
    | 'bot:kill'
    | 'bot:position_size'
    | 'bot:trading_pair'
    | 'bot:orders_cancel'
    | 'bot:orders_manage'
    | 'bot:orders_read'
    | 'bot:status_read'
    | 'bot:wallet_read'
    | 'bot:trades_read'
    | 'bot:price_read';

/**
 * Permission hierarchy.
 * Higher roles inherit all permissions from lower roles.
 */
const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
    readonly: [
        'bot:status_read',
        'bot:wallet_read',
        'bot:trades_read',
        'bot:price_read',
        'bot:orders_read',
    ],
    operator: [
        // Inherits readonly
        'bot:status_read',
        'bot:wallet_read',
        'bot:trades_read',
        'bot:price_read',
        'bot:orders_read',
        // Operator-specific
        'bot:orders_manage',
    ],
    admin: [
        // Inherits all
        'bot:status_read',
        'bot:wallet_read',
        'bot:trades_read',
        'bot:price_read',
        'bot:orders_read',
        'bot:orders_manage',
        // Admin-specific
        'bot:run',
        'bot:pause',
        'bot:kill',
        'bot:position_size',
        'bot:trading_pair',
        'bot:orders_cancel',
    ],
};

/**
 * Check if a role has a specific permission.
 */
export function hasPermission(role: Role, permission: Permission): boolean {
    const permissions = ROLE_PERMISSIONS[role];
    return permissions?.includes(permission) ?? false;
}

/**
 * Get all permissions for a role.
 */
export function getPermissions(role: Role): Permission[] {
    return ROLE_PERMISSIONS[role] ?? [];
}

/**
 * Get the minimum role required for a permission.
 */
export function getRequiredRole(permission: Permission): Role {
    if (ROLE_PERMISSIONS.readonly.includes(permission)) return 'readonly';
    if (ROLE_PERMISSIONS.operator.includes(permission)) return 'operator';
    return 'admin';
}
