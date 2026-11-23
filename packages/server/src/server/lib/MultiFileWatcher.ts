import EventEmitter from "events";
import fs from "fs";
import path from "path";

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

    private dirWatchers = new Map<string, fs.FSWatcher>();

    private previousStats: Record<string, FileStat> = {};

    private stopped = false;

    constructor(filePaths: string[]) {
        super();
        this.filePaths = filePaths;
    }

    start() {
        this.stopped = false;
        for (const filePath of this.filePaths) {
            this.watchFile(filePath);
        }
    }

    private closeWatcher(map: Map<string, fs.FSWatcher>, filePath: string) {
        const existing = map.get(filePath);
        if (existing) {
            existing.close();
            map.delete(filePath);
        }
    }

    private watchParentDir(filePath: string) {
        if (this.stopped) return;
        this.closeWatcher(this.watchers, filePath);
        if (this.dirWatchers.has(filePath)) return;

        const dirPath = path.dirname(filePath);
        const baseName = path.basename(filePath);
        try {
            const dirWatcher = fs.watch(dirPath, { encoding: "utf8", persistent: false, recursive: false });
            dirWatcher.on("change", async (_eventType, filename) => {
                if (this.stopped) return;
                if (filename && filename.toString() !== baseName) return;
                if (!fs.existsSync(filePath)) return;

                this.closeWatcher(this.dirWatchers, filePath);
                const prevStat = this.previousStats[filePath];
                this.watchFile(filePath);
                try {
                    const currentStat = await fs.promises.stat(filePath);
                    this.emit("change", {
                        filePath,
                        prevStat: prevStat ? { ...prevStat } : undefined,
                        currentStat: { ...currentStat }
                    });
                    this.previousStats[filePath] = currentStat;
                } catch (err: any) {
                    if (err?.code === "ENOENT") {
                        this.watchParentDir(filePath);
                    } else {
                        this.emit("error", err);
                    }
                }
            });
            dirWatcher.on("error", error => {
                this.closeWatcher(this.dirWatchers, filePath);
                this.emit("error", error);
            });
            this.dirWatchers.set(filePath, dirWatcher);
        } catch (err) {
            this.emit("error", err);
        }
    }

    private watchFile(filePath: string) {
        if (this.stopped) return;
        this.closeWatcher(this.watchers, filePath);
        this.closeWatcher(this.dirWatchers, filePath);

        if (!fs.existsSync(filePath)) {
            this.watchParentDir(filePath);
            return;
        }

        // Load the initial stats if the file exists
        try {
            this.previousStats[filePath] = fs.statSync(filePath);
        } catch (err: any) {
            if (err?.code === "ENOENT") {
                this.watchParentDir(filePath);
                return;
            }
            this.emit("error", err);
            return;
        }

        let watcher: fs.FSWatcher;
        try {
            watcher = fs.watch(filePath, { encoding: "utf8", persistent: false, recursive: false });
        } catch (err: any) {
            if (err?.code === "ENOENT") {
                this.watchParentDir(filePath);
                return;
            }
            this.emit("error", err);
            return;
        }
        watcher.on("change", async (eventType, _) => {
            if (this.stopped) return;
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
                } catch (err: any) {
                    if (err?.code === "ENOENT") {
                        this.watchParentDir(filePath);
                    } else {
                        this.emit("error", err);
                    }
                }
                return;
            }
            if (eventType !== "change") return;

            try {
                const currentStat = await fs.promises.stat(filePath);
                const prevStat = this.previousStats[filePath];
                this.emit("change", {
                    filePath,
                    prevStat: prevStat ? { ...prevStat } : undefined,
                    currentStat: { ...currentStat }
                });

                this.previousStats[filePath] = currentStat;
            } catch (err: any) {
                if (err?.code === "ENOENT") {
                    this.watchParentDir(filePath);
                } else {
                    this.emit("error", err);
                }
            }
        });

        watcher.on("error", error => {
            if (this.stopped) return;
            if (!fs.existsSync(filePath)) {
                this.watchParentDir(filePath);
                return;
            }
            this.emit("error", error);
        });

        this.watchers.set(filePath, watcher);
    }

    stop() {
        this.stopped = true;
        for (const watcher of this.watchers.values()) {
            watcher.close();
        }
        this.watchers.clear();
        for (const dirWatcher of this.dirWatchers.values()) {
            dirWatcher.close();
        }
        this.dirWatchers.clear();
    }
}
