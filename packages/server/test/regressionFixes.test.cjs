const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const babel = require("@babel/core");

const loadTypeScriptModule = (modulePath, overrides = {}) => {
    const transformed = babel.transformFileSync(modulePath, {
        presets: [
            [require.resolve("@babel/preset-env"), { targets: { node: "20" }, modules: "commonjs" }],
            require.resolve("@babel/preset-typescript")
        ]
    });
    const loadedModule = { exports: {} };
    const loadModule = new Function("module", "exports", "require", "__dirname", "__filename", transformed.code);
    const customRequire = request => overrides[request] ?? require(request);
    loadModule(loadedModule, loadedModule.exports, customRequire, path.dirname(modulePath), modulePath);
    return loadedModule.exports;
};

const srcRoot = path.join(__dirname, "../src/server");
const scriptsRoot = path.join(__dirname, "../scripts");

test("CloudflareManager.emitError and handleData do not throw ERR_UNHANDLED_ERROR with 0 error listeners", async () => {
    const logs = [];
    class MockLoggable extends EventEmitter {
        log = {
            info: () => {},
            debug: () => {},
            warn: () => {},
            error: msg => logs.push(msg)
        };
    }
    const { CloudflareManager } = loadTypeScriptModule(path.join(srcRoot, "managers/cloudflareManager/index.ts"), {
        "@server/fileSystem": { FileSystem: { resources: "/tmp" } },
        "@server": { Server: () => ({ repo: { getConfig: () => "1234" } }) },
        "@server/helpers/utils": {
            isEmpty: v => !v,
            isNotEmpty: v => Boolean(v && v.length),
            waitMs: async () => {}
        },
        "@server/lib/logging/Loggable": { Loggable: MockLoggable },
        "@server/lib/ProcessSpawner": { ProcessSpawner: class {} }
    });

    const mgr = new CloudflareManager();
    assert.equal(mgr.listenerCount("error"), 0);
    assert.doesNotThrow(() => mgr.emitError(new Error("boom")));
    assert.equal(logs.length, 1);

    let needsRestart = false;
    mgr.on("needs-restart", () => {
        needsRestart = true;
    });
    await mgr.handleData("context deadline exceeded\nRetrying connection in up to 32s");
    assert.equal(needsRestart, true);
});

test("ZrokManager.handleError and start() catch do not throw ERR_UNHANDLED_ERROR with 0 error listeners", async () => {
    const logs = [];
    class MockLoggable extends EventEmitter {
        log = {
            info: () => {},
            debug: () => {},
            warn: () => {},
            error: msg => logs.push(msg)
        };
    }
    const { ZrokManager } = loadTypeScriptModule(path.join(srcRoot, "managers/zrokManager/index.ts"), {
        "@server/helpers/utils": { isEmpty: v => !v, isNotEmpty: v => Boolean(v && v.length) },
        "@server/lib/logging/Loggable": { Loggable: MockLoggable, getLogger: () => ({}) },
        "@server/fileSystem": { FileSystem: { resources: "/tmp" } },
        axios: {},
        electron: { app: { getVersion: () => "1.9.12" } },
        "@server": { Server: () => ({ repo: { getConfig: () => "1234" } }) },
        "@server/lib/ProcessSpawner": { ProcessSpawner: class {}, ProcessSpawnerError: Error }
    });

    const mgr = new ZrokManager();
    assert.doesNotThrow(() => mgr.handleError("some zrok error"));
    mgr.connectHandler = async () => {
        throw new Error("connect failed");
    };
    const res = await mgr.start();
    assert.equal(res, null);
    assert.ok(logs.some(m => String(m).includes("connect failed")));
});

test("ProcessSpawner invokes onMaxRetriesExhausted when MAX_RESTART_RETRIES is reached", async () => {
    class MockLoggable extends EventEmitter {
        log = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
    }
    const { ProcessSpawner } = loadTypeScriptModule(path.join(srcRoot, "lib/ProcessSpawner.ts"), {
        "./logging/Loggable": { Loggable: MockLoggable }
    });

    let exhausted = false;
    const spawner = new ProcessSpawner({
        command: "/usr/bin/false",
        restartOnNonZeroExit: true,
        waitForExit: false,
        onMaxRetriesExhausted: () => {
            exhausted = true;
        }
    });
    spawner.retryCount = 10;
    await spawner.handleExit(1);
    assert.equal(exhausted, true);
});

test("MultiFileWatcher re-attaches on rename so recreated files continue emitting change", async () => {
    const { MultiFileWatcher } = loadTypeScriptModule(path.join(srcRoot, "lib/MultiFileWatcher.ts"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-mfw-"));
    const targetFile = path.join(tmpDir, "chat.db-wal");
    fs.writeFileSync(targetFile, "initial");

    const watcher = new MultiFileWatcher([targetFile]);
    const changes = [];
    const errors = [];
    watcher.on("change", ev => changes.push(ev));
    watcher.on("error", err => errors.push(err));
    watcher.start();

    try {
        await new Promise(r => setTimeout(r, 50));
        // Simulate WAL unlink + recreate (triggers macOS fs.watch "rename")
        fs.unlinkSync(targetFile);
        fs.writeFileSync(targetFile, "recreated-content");
        await new Promise(r => setTimeout(r, 200));

        // Now write again to verify the re-attached watcher is live on the new inode
        fs.appendFileSync(targetFile, "-more");
        await new Promise(r => setTimeout(r, 200));

        assert.ok(changes.length >= 1, `Expected >=1 change event after rename+write, got ${changes.length}`);
        assert.equal(errors.length, 0);
    } finally {
        watcher.stop();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("CaffeinateService ignores stale child close after stop() -> start()", () => {
    class MockLoggable {
        log = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
    }
    const children = [];
    const { CaffeinateService } = loadTypeScriptModule(path.join(srcRoot, "services/caffeinateService/index.ts"), {
        child_process: {
            spawn: () => {
                const proc = new EventEmitter();
                proc.pid = 1000 + children.length;
                proc.kill = () => true;
                children.push(proc);
                return proc;
            }
        },
        "@server/lib/logging/Loggable": { Loggable: MockLoggable }
    });

    const svc = new CaffeinateService();
    svc.start();
    const childA = children[0];
    svc.stop();
    svc.start();
    const childB = children[1];

    assert.equal(svc.isCaffeinated, true);
    assert.equal(svc.childProc, childB);

    // Stale close from childA must not clear childB's isCaffeinated flag
    childA.emit("close", 0);
    assert.equal(svc.isCaffeinated, true);
    assert.equal(svc.childProc, childB);

    // Close from childB should clear it
    childB.emit("close", 0);
    assert.equal(svc.isCaffeinated, false);
    assert.equal(svc.childProc, null);
});

test("BlueBubblesServer.startServices() resets isStopping = false for hotRestart()", () => {
    const serverSource = fs.readFileSync(path.join(srcRoot, "index.ts"), "utf8");
    const match = serverSource.match(/async startServices\(\):\s*Promise<void>\s*\{([\s\S]{0,120})/);
    assert.ok(match, "startServices() should exist");
    assert.ok(match[1].includes("this.isStopping = false;"), "startServices() must reset this.isStopping = false");
});

test("Swift bridges do not permanently give up after 60s and synchronize CameraBridge decode", () => {
    const videoSrc = fs.readFileSync(path.join(scriptsRoot, "BlueBubblesVideoBridge.swift"), "utf8");
    assert.equal(videoSrc.includes("maxReacquireWait"), false);
    assert.ok(videoSrc.includes("reacquireScheduled"));

    const audioSrc = fs.readFileSync(path.join(scriptsRoot, "BlueBubblesAudioBridge.swift"), "utf8");
    assert.equal(audioSrc.includes("let maxWait: TimeInterval = 60.0"), false);

    const camSrc = fs.readFileSync(path.join(scriptsRoot, "BlueBubblesCameraBridge.swift"), "utf8");
    assert.ok(camSrc.includes("defer { lock.unlock() }"));
});
