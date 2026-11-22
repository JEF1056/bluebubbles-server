import fs from "fs";
import { MultiFileWatcher } from "@server/lib/MultiFileWatcher";
import type { FileChangeEvent } from "@server/lib/MultiFileWatcher";
import { Loggable } from "@server/lib/logging/Loggable";
import { Sema } from "async-sema";
import { IMessageCache, IMessagePoller } from "../pollers";
import { MessageRepository } from "..";
import { waitMs } from "@server/helpers/utils";
import { DebounceSubsequentWithWait } from "@server/lib/decorators/DebounceDecorator";
import { Server } from "@server";

const DEFAULT_POLL_DEBOUNCE_MS = 500;
const MIN_POLL_DEBOUNCE_MS = 100;
const DEFAULT_HEALTHY_POLL_INTERVAL_MS = 15000;
const WATCHER_ERROR_FALLBACK_POLL_INTERVAL_MS = 1000;

// Cap debounce at DEFAULT_POLL_DEBOUNCE_MS so raising db_poll_interval does not delay fs.watch delivery.
export const getPollDebounceMs = (): number => {
    const configured = Server()?.repo?.getConfig("db_poll_interval") as number;
    if (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0) {
        return DEFAULT_POLL_DEBOUNCE_MS;
    }
    return Math.min(DEFAULT_POLL_DEBOUNCE_MS, Math.max(MIN_POLL_DEBOUNCE_MS, configured));
};

export const getFileStatSignature = async (filePaths: string[]): Promise<string> => {
    const parts = await Promise.all(
        filePaths.map(async (filePath) => {
            try {
                const stat = await fs.promises.stat(filePath);
                return `${filePath}:${stat.mtimeMs}:${stat.size}`;
            } catch {
                return `${filePath}:missing`;
            }
        })
    );
    return parts.join("|");
};

export class IMessageListener extends Loggable {
    tag = "IMessageListener";

    stopped: boolean;

    filePaths: string[];

    watcher: MultiFileWatcher;

    repo: MessageRepository;

    processLock: Sema;

    pollers: IMessagePoller[];

    cache: IMessageCache;

    lastCheck = 0;

    pollIntervalMs: number;

    pollTimer: NodeJS.Timeout | null = null;

    lastStatSignature: string | null = null;

    constructor({
        filePaths,
        repo,
        cache,
        pollIntervalMs = DEFAULT_HEALTHY_POLL_INTERVAL_MS
    }: {
        filePaths: string[],
        repo: MessageRepository,
        cache: IMessageCache,
        pollIntervalMs?: number
    }) {
        super();

        this.filePaths = filePaths;
        this.repo = repo;
        this.pollers = [];
        this.cache = cache;
        this.pollIntervalMs = pollIntervalMs;
        this.stopped = false;
        this.processLock = new Sema(1);
    }

    stop() {
        this.stopped = true;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this.watcher?.stop();
        this.removeAllListeners();
    }

    addPoller(poller: IMessagePoller) {
        this.pollers.push(poller);
    }

    getEarliestModifiedDate() {
        let earliest = new Date();
        for (const filePath of this.filePaths) {
            const stat = fs.statSync(filePath);
            if (stat.mtime < earliest) {
                earliest = stat.mtime;
            }
        }

        return earliest;
    }

    async start() {
        this.lastCheck = this.getEarliestModifiedDate().getTime() - 60000;
        this.stopped = false;

        // Perform an initial poll to kinda seed the cache.
        // We'll use the earliest modified date of the files to determine the initial poll date.
        // We'll also subtract 1 minute just to pre-load the cache with a little bit of data.
        await this.poll(new Date(this.lastCheck), false);

        this.watcher = new MultiFileWatcher(this.filePaths);
        this.watcher.on("change", async (event: FileChangeEvent) => {
            await this.handleChangeEvent(event);
        });

        this.watcher.on("error", (error) => {
            this.log.error(`Failed to watch database files: ${this.filePaths.join(", ")}`);
            this.log.debug(`Error: ${error}`);
            if (!this.stopped && this.pollIntervalMs > WATCHER_ERROR_FALLBACK_POLL_INTERVAL_MS) {
                this.pollIntervalMs = WATCHER_ERROR_FALLBACK_POLL_INTERVAL_MS;
                if (this.pollTimer) {
                    clearInterval(this.pollTimer);
                    this.pollTimer = null;
                }
                this.startPollTimer();
            }
        });

        this.watcher.start();
        this.lastStatSignature = await getFileStatSignature(this.filePaths);
        this.startPollTimer();
    }

    startPollTimer() {
        if (this.pollTimer || this.pollIntervalMs <= 0) return;

        this.pollTimer = setInterval(async () => {
            const signature = await getFileStatSignature(this.filePaths);
            if (signature === this.lastStatSignature) return;
            this.lastStatSignature = signature;
            await this.handleChangeEvent({
                filePath: "poll-interval",
                prevStat: null,
                currentStat: null
            });
        }, this.pollIntervalMs);
        this.pollTimer.unref?.();
    }

    @DebounceSubsequentWithWait('IMessageListener.handleChangeEvent', getPollDebounceMs)
    async handleChangeEvent(event: FileChangeEvent) {
        await this.processLock.acquire();
        try {
            // Snapshot before polling so any write landing mid-poll is caught on the next tick.
            this.lastStatSignature = await getFileStatSignature(this.filePaths);
            const now = Date.now();
            let prevTime = this.lastCheck;
    
            if (prevTime <= 0 || prevTime > now) {
                this.log.debug(`Previous time is invalid (${prevTime}), setting to now...`);
                prevTime = now;
            } else if (now - prevTime > 86400000) {
                this.log.debug(`Previous time is > 24 hours ago, setting to 24 hours ago...`);
                prevTime = now - 86400000;
            }
    
            let afterTime = prevTime - 30000;
            if (afterTime > now) {
                afterTime = now;
            }
            await this.poll(new Date(afterTime));
            this.lastCheck = now;
    
            this.cache.trimCaches();
            Server().messageManager.prune();
            if (this.processLock.nrWaiting() > 0) {
                await waitMs(100);
            }
        } catch (error) {
            this.log.error(`Error handling change event: ${error}`);
        } finally {
            this.processLock.release();
        }
    }

    async poll(after: Date, emitResults = true) {
        for (const poller of this.pollers) {
            const results = await poller.poll(after);

            if (emitResults) {
                for (const result of results) {
                    this.emit(result.eventType, result.data);
                    await waitMs(10);
                }
            }
        }
    }
}
