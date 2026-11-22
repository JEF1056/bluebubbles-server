import EventEmitter from "events";
import fs from "fs";

export type FileStat = fs.Stats | null | undefined;

export type FileChangeHandlerCallback = (event: FileChangeEvent) => Promise<void>;

export type FileChangeEvent = {
    currentStat: FileStat;
    prevStat: FileStat;
    filePath: string;
};

export class MultiFileWatcher extends EventEmitter {
    tag = "MultiFileWatcher";

    private readonly filePaths: string[];

    private watchers = new Map<string, fs.FSWatcher>();

    private previousStats: Record<string, FileStat> = {};

    constructor(filePaths: string[]) {
        super();
        this.filePaths = filePaths;
    }

    start() {
        for (const filePath of this.filePaths) {
            this.watchFile(filePath);
        }
    }

    private watchFile(filePath: string) {
        const existing = this.watchers.get(filePath);
        if (existing) {
            existing.close();
            this.watchers.delete(filePath);
        }

        if (!fs.existsSync(filePath)) {
            this.emit("error", new Error(`Watched file does not exist: ${filePath}`));
            return;
        }

        // Load the initial stats if the file exists
        this.previousStats[filePath] = fs.statSync(filePath);

        const watcher = fs.watch(filePath, { encoding: "utf8", persistent: false, recursive: false });
        watcher.on("change", async (eventType, _) => {
            if (eventType === "rename") {
                try {
                    const prevStat = this.previousStats[filePath];
                    this.watchFile(filePath);
                    if (fs.existsSync(filePath)) {
                        const currentStat = await fs.promises.stat(filePath);
                        this.emit("change", {
                            filePath,
                            prevStat: prevStat ? { ...prevStat } : undefined,
                            currentStat: { ...currentStat }
                        });
                        this.previousStats[filePath] = currentStat;
                    }
                } catch (err) {
                    this.emit("error", err);
                }
                return;
            }
            if (eventType !== "change") return;

            try {
                const currentStat = await fs.promises.stat(filePath);
                this.emit("change", {
                    filePath,
                    prevStat: { ...this.previousStats[filePath] },
                    currentStat: { ...currentStat }
                });

                this.previousStats[filePath] = currentStat;
            } catch (err) {
                this.emit("error", err);
            }
        });

        watcher.on("error", error => {
            this.emit("error", error);
        });

        this.watchers.set(filePath, watcher);
    }

    stop() {
        for (const watcher of this.watchers.values()) {
            watcher.close();
        }
        this.watchers.clear();
    }
}
