import { EventEmitter } from "events";

export class ScheduledService extends EventEmitter {
    eventName = "timeout";

    action: () => void | Promise<void>;

    handle: NodeJS.Timer;

    interval: number;

    stopped = false;

    private inFlight = false;

    constructor(action: () => void | Promise<void>, ms: number, autoStart = true) {
        super();
        this.action = action;
        this.handle = undefined;
        this.interval = ms;
        this.addListener(this.eventName, this.action);

        if (autoStart) {
            this.start();
        }
    }

    addCustomListener(listener: (...args: any[]) => void | Promise<void>) {
        this.addListener(this.eventName, listener);
    }

    start() {
        this.stopped = false;
        if (!this.handle) {
            this.handle = setInterval(() => {
                void this.runTick();
            }, this.interval);
            this.handle.unref?.();
        }
    }

    private async runTick(): Promise<void> {
        if (this.inFlight || this.stopped) return;
        this.inFlight = true;
        try {
            const listeners = this.listeners(this.eventName) as Array<(...args: any[]) => unknown>;
            await Promise.all(listeners.map(fn => Promise.resolve().then(() => fn())));
        } catch (ex) {
            console.error("ScheduledService tick failed:", ex);
        } finally {
            this.inFlight = false;
        }
    }

    stop() {
        if (this.handle) {
            clearInterval(this.handle);
            this.handle = undefined;
            this.stopped = true;
        }
    }
}
