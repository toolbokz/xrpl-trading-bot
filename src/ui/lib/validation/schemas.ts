/**
 * Input validation schemas using Zod.
 * Centralized validation for all mutation endpoints.
 */

import { z } from 'zod';
import { isValidPairKey } from '../../../market/instrumentRegistry';

/**
 * /api/bot/position-size POST body
 */
export const positionSizeSchema = z.object({
    size: z
        .number({ required_error: 'size is required' })
        .positive('size must be positive')
        .finite('size must be finite')
        .max(1_000_000, 'size exceeds maximum (1,000,000)'),
});

export type PositionSizeInput = z.infer<typeof positionSizeSchema>;

/**
 * /api/bot/trading-pair POST body
 * Validates that the pairKey is in the allowed TRADING_PAIRS list.
 */
export const tradingPairSchema = z.object({
    pairKey: z
        .string({ required_error: 'pairKey is required' })
        .min(1, 'pairKey cannot be empty')
        .max(100, 'pairKey too long')
        .refine(isValidPairKey, {
            message: 'pairKey must be a valid trading pair from the allowed list',
        }),
});

export type TradingPairInput = z.infer<typeof tradingPairSchema>;

/**
 * /api/bot/orders POST body (update settings)
 */
export const ordersUpdateSchema = z.object({
    autoManageEnabled: z.boolean().optional(),
    stalenessThresholdSec: z
        .number()
        .positive('stalenessThresholdSec must be positive')
        .int('stalenessThresholdSec must be an integer')
        .max(3600, 'stalenessThresholdSec exceeds maximum (3600)')
        .optional(),
});

export type OrdersUpdateInput = z.infer<typeof ordersUpdateSchema>;

/**
 * /api/bot/orders DELETE body (cancel offer)
 */
export const ordersCancelSchema = z.object({
    sequence: z
        .number({ required_error: 'sequence is required' })
        .int('sequence must be an integer')
        .positive('sequence must be positive'),
});

export type OrdersCancelInput = z.infer<typeof ordersCancelSchema>;

/**
 * Safe error details for client response.
 * Strips internal paths and sensitive information.
 */
export interface ValidationErrorDetail {
    field: string;
    message: string;
}

/**
 * Format Zod errors for client response.
 * Only includes field path and message, no internal details.
 */
export function formatZodErrors(error: z.ZodError): ValidationErrorDetail[] {
    return error.errors.map((e) => ({
        field: e.path.join('.') || 'body',
        message: e.message,
    }));
}

/**
 * Validate request body against a schema.
 * Returns { success: true, data } or { success: false, errors }.
 */
export function validateBody<T>(
    body: unknown,
    schema: z.ZodSchema<T>
): { success: true; data: T } | { success: false; errors: ValidationErrorDetail[] } {
    const result = schema.safeParse(body);

    if (result.success) {
        return { success: true, data: result.data };
    }

    return { success: false, errors: formatZodErrors(result.error) };
}
