/**
 * Monitoring module index.
 * Export all monitoring utilities.
 */

export {
    CpuWatchdog,
    getCpuWatchdog,
    startCpuWatchdog,
    isCpuHealthy,
    CPU_MAX_PERCENT,
    CPU_MAX_DURATION_MS,
    type CpuWatchdogConfig,
    type CpuSample,
} from './cpuWatchdog';

export {
    EventLoopLagTracker,
    getEventLoopLagTracker,
    stopEventLoopLagTracker,
    shouldAutoPauseTrading,
    recordInfraLagSample,
    type EventLoopLagConfig,
    type EventLoopLagState,
    type InfraSafetyState,
} from './eventLoopLag';
