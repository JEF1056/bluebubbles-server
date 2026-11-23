/**
 * Polyfills `AbortSignal.any` for Electron 25 (Node 18.15.0) where werift 0.27+
 * calls `AbortSignal.any(...)` in ICE checks (`ice.js`) and RTP pacing (`rtpSender.js`).
 */
export function ensureAbortSignalAny(): void {
    if (typeof AbortSignal === "undefined" || typeof (AbortSignal as any).any === "function") {
        return;
    }

    Object.defineProperty(AbortSignal, "any", {
        configurable: true,
        writable: true,
        value: function any(signals: Iterable<AbortSignal>): AbortSignal {
            const list = Array.from(signals);
            for (const sig of list) {
                if (sig?.aborted) {
                    return AbortSignal.abort(sig.reason);
                }
            }

            const controller = new AbortController();
            if (list.length === 0) return controller.signal;

            const seen = new Set<AbortSignal>();
            const listeners = new Map<AbortSignal, () => void>();
            const cleanup = () => {
                for (const [sig, fn] of listeners) {
                    sig.removeEventListener("abort", fn);
                }
                listeners.clear();
            };

            for (const sig of list) {
                if (!sig || seen.has(sig)) continue;
                seen.add(sig);
                const onAbort = () => {
                    cleanup();
                    controller.abort(sig.reason);
                };
                listeners.set(sig, onAbort);
                sig.addEventListener("abort", onAbort, { once: true });
            }

            return controller.signal;
        }
    });
}

ensureAbortSignalAny();
