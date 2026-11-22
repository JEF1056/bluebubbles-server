import { useEffect, useRef } from 'react';

// See: https://usehooks-ts.com/react-hook/use-isomorphic-layout-effect
import { useIsomorphicLayoutEffect } from './UseIsomorphicLayoutEffect';

export const useInterval = (callback: () => void, delay: number | null) => {
    const savedCallback = useRef(callback);

    // Remember the latest callback if it changes.
    useIsomorphicLayoutEffect(() => {
        savedCallback.current = callback;
    }, [callback]);

    // Set up the interval, pausing while the document is hidden.
    useEffect(() => {
        // Don't schedule if no delay is specified.
        // Note: 0 is a valid value for delay.
        if (!delay && delay !== 0) return;

        let id: ReturnType<typeof setInterval> | null = null;
        const start = () => {
            if (id !== null || (typeof document !== 'undefined' && document.hidden)) return;
            id = setInterval(() => {
                if (typeof document !== 'undefined' && document.hidden) return;
                savedCallback.current();
            }, delay);
        };
        const stop = () => {
            if (id !== null) {
                clearInterval(id);
                id = null;
            }
        };
        const onVisibilityChange = () => {
            if (document.hidden) {
                stop();
            } else {
                start();
            }
        };

        start();
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', onVisibilityChange);
        }

        return () => {
            stop();
            if (typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', onVisibilityChange);
            }
        };
    }, [delay]);
};
