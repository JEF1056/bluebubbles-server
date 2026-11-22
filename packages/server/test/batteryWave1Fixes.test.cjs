const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const ts = require("typescript");

function loadTsModule(relPath, mocks = {}) {
    const sourcePath = path.join(__dirname, "..", relPath);
    const source = fs.readFileSync(sourcePath, "utf8");
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2018,
            esModuleInterop: true,
            experimentalDecorators: true
        }
    });
    const mod = new Module(sourcePath, module);
    mod.filename = sourcePath;
    mod.paths = Module._nodeModulePaths(path.dirname(sourcePath));
    const origRequire = mod.require.bind(mod);
    mod.require = id => (Object.prototype.hasOwnProperty.call(mocks, id) ? mocks[id] : origRequire(id));
    mod._compile(compiled.outputText, sourcePath);
    return mod.exports;
}

const noopLoggable = {
    Loggable: class extends EventEmitter {
        log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    }
};

function makeFakeChildProcess() {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.killed = false;
    proc.pid = 4321;
    proc.kill = () => {
        proc.killed = true;
        return true;
    };
    return proc;
}

test("ProcessSpawner backoff caps at 60s, stops after 10 retries, resets after >60s run, and kill disables restart", async () => {
    const spawned = [];
    const { ProcessSpawner } = loadTsModule("src/server/lib/ProcessSpawner.ts", {
        child_process: {
            spawn: () => {
                const proc = makeFakeChildProcess();
                spawned.push(proc);
                return proc;
            }
        },
        "./logging/Loggable": noopLoggable
    });

    const origSetTimeout = global.setTimeout;
    const origClearTimeout = global.clearTimeout;
    const origDateNow = Date.now;

    let now = 1_000_000;
    let nextTimerId = 1;
    const timers = new Map();
    const scheduledDelays = [];

    global.Date.now = () => now;
    global.setTimeout = (fn, delay) => {
        const id = nextTimerId++;
        timers.set(id, { fn, delay });
        scheduledDelays.push(delay);
        return { id, unref: () => {} };
    };
    global.clearTimeout = handle => {
        if (handle && typeof handle === "object" && "id" in handle) {
            timers.delete(handle.id);
        }
    };

    try {
        const spawner = new ProcessSpawner({
            command: "cloudflared",
            args: ["tunnel"],
            restartOnNonZeroExit: true,
            waitForExit: false
        });

        await spawner.execute();
        assert.equal(spawned.length, 1);

        // Trigger 11 consecutive non-zero exits; only 10 restarts should schedule with 2s*2^n capped at 60s
        for (let i = 0; i < 11; i++) {
            const current = spawned[spawned.length - 1];
            current.emit("exit", 1);
            if (i < 10) {
                assert.equal(timers.size, 1, `retry ${i + 1} should schedule a timer`);
                const [id, entry] = timers.entries().next().value;
                timers.delete(id);
                entry.fn();
                await Promise.resolve();
            } else {
                assert.equal(timers.size, 0, "11th exit should not schedule beyond max 10 retries");
            }
        }

        assert.deepEqual(scheduledDelays, [
            2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000, 60000
        ]);
        assert.equal(spawned.length, 11);

        // A fresh execute() that runs >60s should reset retry backoff back to 2000ms
        await spawner.execute();
        now += 61_000;
        spawned[spawned.length - 1].emit("exit", 1);
        assert.equal(scheduledDelays[scheduledDelays.length - 1], 2000);
        assert.equal(timers.size, 1);

        // kill() must clear restartOnNonZeroExit and cancel pending restart timers
        await spawner.kill();
        assert.equal(spawner.restartOnNonZeroExit, false);
        assert.equal(timers.size, 0);
        assert.equal(spawned[spawned.length - 1].killed, true);

        spawned[spawned.length - 1].emit("exit", 1);
        assert.equal(timers.size, 0);
    } finally {
        global.setTimeout = origSetTimeout;
        global.clearTimeout = origClearTimeout;
        global.Date.now = origDateNow;
    }
});

test("NetworkCheckerService guards duplicate starts, uses dns.promises.resolve, and polls every 300s", async () => {
    const createdLoops = [];
    let resolveShouldSucceed = true;
    const resolvedHosts = [];

    class FakeScheduledService {
        constructor(callback, interval) {
            this.callback = callback;
            this.interval = interval;
            this.stopped = false;
            createdLoops.push(this);
        }
        stop() {
            this.stopped = true;
        }
    }

    const { NetworkCheckerService } = loadTsModule("src/server/services/networkCheckerService/index.ts", {
        "@server/lib/ScheduledService": { ScheduledService: FakeScheduledService },
        "@server/lib/logging/Loggable": noopLoggable,
        dns: {
            promises: {
                resolve: async host => {
                    resolvedHosts.push(host);
                    if (!resolveShouldSucceed) throw new Error("ENOTFOUND");
                    return ["1.2.3.4"];
                }
            }
        }
    });

    const svc = new NetworkCheckerService();
    await svc.start();
    assert.equal(createdLoops.length, 1);
    assert.equal(createdLoops[0].interval, 300000);
    assert.equal(createdLoops[0].stopped, false);
    assert.equal(svc.online, true);
    assert.deepEqual(resolvedHosts, ["www.google.com"]);

    // Second start() must stop the first loop before creating a replacement
    resolveShouldSucceed = false;
    await svc.start();
    assert.equal(createdLoops.length, 2);
    assert.equal(createdLoops[0].stopped, true);
    assert.equal(createdLoops[1].stopped, false);
    assert.equal(svc.online, false);

    // Scheduled callback emits status-change on recovery
    let statusChange = null;
    svc.on("status-change", val => {
        statusChange = val;
    });
    resolveShouldSucceed = true;
    await createdLoops[1].callback();
    assert.equal(svc.online, true);
    assert.equal(statusChange, true);

    svc.stop();
    assert.equal(createdLoops[1].stopped, true);
    assert.equal(svc.isStopped, true);

    // Concurrent start() calls while checkNetwork() is in flight must not leak an extra loop
    let releaseFirst;
    let releaseSecond;
    let callNum = 0;
    const { NetworkCheckerService: ConcurrentNetSvc } = loadTsModule("src/server/services/networkCheckerService/index.ts", {
        "@server/lib/ScheduledService": { ScheduledService: FakeScheduledService },
        "@server/lib/logging/Loggable": noopLoggable,
        dns: {
            promises: {
                resolve: () =>
                    new Promise(resolve => {
                        callNum++;
                        if (callNum === 1) releaseFirst = () => resolve(["1.1.1.1"]);
                        else if (callNum === 2) releaseSecond = () => resolve(["8.8.8.8"]);
                        else resolve(["1.2.3.4"]);
                    })
            }
        }
    });

    const concurrentLoopsStart = createdLoops.length;
    const concurrentSvc = new ConcurrentNetSvc();
    const p1 = concurrentSvc.start();
    const p2 = concurrentSvc.start();
    releaseFirst();
    await p1;
    assert.equal(createdLoops.length, concurrentLoopsStart, "stale first start() must abort without creating a loop");
    releaseSecond();
    await p2;
    assert.equal(createdLoops.length, concurrentLoopsStart + 1, "only latest start() creates a loop");
    assert.equal(createdLoops[concurrentLoopsStart].stopped, false);
    concurrentSvc.stop();
    assert.equal(createdLoops[concurrentLoopsStart].stopped, true);
});

test("CaffeinateService drops -m flag and binds onClose across emitter events", () => {
    const spawnCalls = [];
    const proc = makeFakeChildProcess();
    const { CaffeinateService } = loadTsModule("src/server/services/caffeinateService/index.ts", {
        child_process: {
            spawn: (cmd, args, opts) => {
                spawnCalls.push({ cmd, args, opts });
                return proc;
            }
        },
        "@server/lib/logging/Loggable": noopLoggable
    });

    const svc = new CaffeinateService();
    svc.start();
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].cmd, "caffeinate");
    assert.ok(!spawnCalls[0].args.includes("-m"));
    assert.deepEqual(spawnCalls[0].args.slice(0, 3), ["-i", "-s", "-w"]);
    assert.equal(svc.isCaffeinated, true);

    proc.emit("exit", 0);
    assert.equal(svc.isCaffeinated, false);
});

test("IMessageListener defaults to 15s poll interval and falls back to 1s on watcher error", async () => {
    const watcherInstances = [];
    class FakeWatcher extends EventEmitter {
        start() {}
        stop() {}
    }

    const { IMessageListener } = loadTsModule("src/server/databases/imessage/listeners/IMessageListener.ts", {
        "@server/lib/MultiFileWatcher": {
            MultiFileWatcher: class extends FakeWatcher {
                constructor(paths) {
                    super();
                    this.paths = paths;
                    watcherInstances.push(this);
                }
            }
        },
        "@server/lib/logging/Loggable": noopLoggable,
        "@server/helpers/utils": { waitMs: async () => {} },
        "@server/lib/decorators/DebounceDecorator": { DebounceSubsequentWithWait: () => () => {} },
        "@server": { Server: () => ({ repo: { getConfig: () => 15000 } }) },
        fs: {
            statSync: () => ({ mtime: new Date() }),
            promises: { stat: async () => ({ mtimeMs: 1, size: 1 }) }
        }
    });

    const listener = new IMessageListener({
        filePaths: ["/tmp/chat.db"],
        repo: {},
        cache: {}
    });
    assert.equal(listener.pollIntervalMs, 15000);
    listener.poll = async () => {};
    await listener.start();
    assert.equal(watcherInstances.length, 1);

    watcherInstances[0].emit("error", new Error("watch failed"));
    assert.equal(listener.pollIntervalMs, 1000);
    listener.stop();
});

test("FaceTimeAudioBridge spawns video with stdin pipe and cleanupAllSessions tears down all sessions", () => {
    const spawnCalls = [];
    const { FaceTimeAudioBridge } = loadTsModule("src/server/api/lib/facetime/FaceTimeAudioBridge.ts", {
        child_process: {
            spawn: (bin, args, opts) => {
                const proc = makeFakeChildProcess();
                spawnCalls.push({ bin, args, opts, proc });
                return proc;
            }
        },
        "@server/lib/logging/Loggable": noopLoggable,
        "@server": { Server: () => null },
        "@server/fileSystem": { FileSystem: { resources: "/tmp/bb-resources" } }
    });

    const bridge = new FaceTimeAudioBridge();
    const fakePc1 = { close: async () => {} };
    const fakePc2 = { close: async () => {} };
    const session1 = { callUuid: "c1", pc: fakePc1, videoStdoutBuffer: Buffer.alloc(0), depacketizer: { reset: () => {} } };
    const session2 = { callUuid: "c2", pc: fakePc2, process: makeFakeChildProcess(), depacketizer: { reset: () => {} } };
    bridge.sessions.set("c1", session1);
    bridge.sessions.set("c2", session2);

    bridge.spawnVideoProcess(session1, "/tmp/BlueBubblesVideoBridge");
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCalls[0].opts.stdio, ["pipe", "pipe", "pipe"]);

    bridge.cleanupAllSessions();
    assert.equal(bridge.sessions.size, 0);
    assert.equal(spawnCalls[0].proc.killed, true);
    assert.equal(session2.process, undefined);
});
