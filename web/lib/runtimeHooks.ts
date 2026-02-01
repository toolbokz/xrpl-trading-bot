import { botController } from './botController';
import { TradingRuntime } from '../../src/runtime/tradingRuntime';

const globalRefs = globalThis as typeof globalThis & {
    _tradingRuntime?: TradingRuntime;
    _runtimeHooksRegistered?: boolean;
};

const runtime = globalRefs._tradingRuntime || new TradingRuntime();
if (!globalRefs._tradingRuntime) {
    globalRefs._tradingRuntime = runtime;
}

export const ensureRuntimeHooks = (): TradingRuntime => {
    if (!globalRefs._runtimeHooksRegistered) {
        botController.setHooks({
            start: () => runtime.start(),
            pause: () => runtime.pause(),
            kill: () => runtime.kill(),
            tick: () => runtime.tick(),
        });
        globalRefs._runtimeHooksRegistered = true;
    }
    return runtime;
};
