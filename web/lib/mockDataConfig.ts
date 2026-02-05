/**
 * Mock Data Configuration
 * 
 * Controls whether UI components use mock data for development/demo purposes.
 * 
 * SAFETY: Mock data is ONLY allowed when:
 * 1. NODE_ENV !== 'production'
 * 2. UI_USE_MOCK_DATA === 'true'
 * 
 * In production, this always returns false regardless of env flags.
 */

// Environment detection (client-side safe)
const isProduction = process.env.NODE_ENV === 'production';
const mockDataEnvFlag = process.env.NEXT_PUBLIC_UI_USE_MOCK_DATA === 'true';

/**
 * Whether mock data is enabled for UI components.
 * Returns false in production regardless of env flags.
 */
export const UI_MOCK_DATA_ENABLED = !isProduction && mockDataEnvFlag;

/**
 * Check if mock data is enabled (function form for dynamic checks).
 */
export function isMockDataEnabled(): boolean {
    return UI_MOCK_DATA_ENABLED;
}

/**
 * Runtime assertion that mock data is not being used in production.
 * Call this in any component that conditionally uses mock data.
 */
export function assertNotProductionMock(context: string): void {
    if (isProduction && mockDataEnvFlag) {
        console.error(
            `[SECURITY] Mock data flag detected in production! Context: ${context}. ` +
            `This should never happen. Check your environment configuration.`
        );
    }
}

/**
 * Get mock data configuration status for UI display.
 */
export function getMockDataStatus(): {
    enabled: boolean;
    isProduction: boolean;
    envFlagSet: boolean;
    warning: string | null;
} {
    return {
        enabled: UI_MOCK_DATA_ENABLED,
        isProduction,
        envFlagSet: mockDataEnvFlag,
        warning: UI_MOCK_DATA_ENABLED
            ? 'Mock data is enabled - data shown is simulated'
            : null,
    };
}
