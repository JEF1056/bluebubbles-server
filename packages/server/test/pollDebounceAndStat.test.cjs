const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
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

test("DebounceSubsequentWithWait clears key before originalMethod resolves so mid-flight calls re-run", async () => {
    const { DebounceSubsequentWithWait } = loadTsModule("src/server/lib/decorators/DebounceDecorator.ts", {
        "@server/helpers/utils": {
            waitMs: ms => new Promise(resolve => setTimeout(resolve, ms))
        }
    });

    let calls = 0;
    let releaseFirst;
    const firstInFlight = new Promise(resolve => {
        releaseFirst = resolve;
    });

    class Target {
        async run() {
            calls += 1;
            if (calls === 1) await firstInFlight;
            return calls;
        }
    }
    const desc = Object.getOwnPropertyDescriptor(Target.prototype, "run");
    DebounceSubsequentWithWait("test-mid-flight", 10)(Target.prototype, "run", desc);
    Object.defineProperty(Target.prototype, "run", desc);

    const instance = new Target();
    const p1 = instance.run();
    // Wait past the 10ms debounce so run() is now in-flight awaiting firstInFlight
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(calls, 1);

    // A second call arriving while the first is in-flight should schedule a new run, not return p1
    const p2 = instance.run();
    releaseFirst();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, 1);
    assert.equal(r2, 2);
});

test("getFileStatSignature detects mtime/size changes and handles missing files", async () => {
    const noop = () => {};
    const { getFileStatSignature } = loadTsModule(
        "src/server/databases/imessage/listeners/IMessageListener.ts",
        {
            "@server/lib/MultiFileWatcher": { MultiFileWatcher: class {} },
            "@server/lib/logging/Loggable": { Loggable: class {} },
            "async-sema": { Sema: class {} },
            "../pollers": {},
            "..": {},
            "@server/helpers/utils": { waitMs: noop },
            "@server/lib/decorators/DebounceDecorator": { DebounceSubsequentWithWait: () => () => {} },
            "@server": { Server: () => null }
        }
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-stat-test-"));
    try {
        const dbFile = path.join(tmpDir, "chat.db");
        const walFile = path.join(tmpDir, "chat.db-wal");
        fs.writeFileSync(dbFile, "abc");

        const sig1 = await getFileStatSignature([dbFile, walFile]);
        const sig2 = await getFileStatSignature([dbFile, walFile]);
        assert.equal(sig1, sig2);
        assert.ok(sig1.includes(`${walFile}:missing`));

        fs.writeFileSync(walFile, "wal-bytes");
        const sig3 = await getFileStatSignature([dbFile, walFile]);
        assert.notEqual(sig3, sig1);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
