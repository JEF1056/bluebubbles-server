const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const babel = require("@babel/core");

function loadTsModule(filePath) {
    const absPath = path.resolve(filePath);
    const source = fs.readFileSync(absPath, "utf8");
    const transformed = babel.transformSync(source, {
        filename: absPath,
        presets: [
            ["@babel/preset-env", { targets: { node: "current" }, modules: "commonjs" }],
            "@babel/preset-typescript"
        ]
    });

    const mod = new Module(absPath);
    mod.filename = absPath;
    mod.paths = Module._nodeModulePaths(path.dirname(absPath));
    mod._compile(transformed.code, absPath);
    return mod.exports;
}

const { PinnedChatsCache, normalizePinnedChatGuids } = loadTsModule(
    path.join(__dirname, "../src/server/api/lib/chats/PinnedChatsCache.ts")
);

test("normalizePinnedChatGuids filters invalid entries and preserves first-seen order", () => {
    assert.deepEqual(normalizePinnedChatGuids(null), []);
    assert.deepEqual(
        normalizePinnedChatGuids([
            "iMessage;-;+15551234567",
            "",
            123,
            "  iMessage;-;+15557654321  ",
            "iMessage;-;+15551234567",
            "iMessage;+;chat123"
        ]),
        ["iMessage;-;+15551234567", "iMessage;-;+15557654321", "iMessage;+;chat123"]
    );
});

test("PinnedChatsCache tracks initialization, ordering, pinIndex, and change detection", () => {
    const cache = new PinnedChatsCache();
    assert.equal(cache.isInitialized(), false);
    assert.equal(cache.getPinInfo("iMessage;-;+15551234567"), null);

    const first = cache.setPinnedGuids(["iMessage;-;+15551234567", "iMessage;+;chat123"]);
    assert.equal(first.changed, true);
    assert.deepEqual(first.pinnedChatGuids, ["iMessage;-;+15551234567", "iMessage;+;chat123"]);
    assert.equal(cache.isInitialized(), true);

    assert.deepEqual(cache.getPinInfo("iMessage;-;+15551234567"), { isPinned: true, pinIndex: 0 });
    assert.deepEqual(cache.getPinInfo("iMessage;+;chat123"), { isPinned: true, pinIndex: 1 });
    assert.deepEqual(cache.getPinInfo("iMessage;-;+19990001111"), { isPinned: false, pinIndex: null });

    const same = cache.setPinnedGuids(["iMessage;-;+15551234567", "iMessage;+;chat123"]);
    assert.equal(same.changed, false);

    const reordered = cache.setPinnedGuids(["iMessage;+;chat123", "iMessage;-;+15551234567"]);
    assert.equal(reordered.changed, true);
    assert.deepEqual(cache.getPinInfo("iMessage;+;chat123"), { isPinned: true, pinIndex: 0 });
    assert.deepEqual(cache.getPinInfo("iMessage;-;+15551234567"), { isPinned: true, pinIndex: 1 });

    const cleared = cache.setPinnedGuids([]);
    assert.equal(cleared.changed, true);
    assert.deepEqual(cache.getPinnedGuids(), []);
    assert.deepEqual(cache.getPinInfo("iMessage;+;chat123"), { isPinned: false, pinIndex: null });
});
