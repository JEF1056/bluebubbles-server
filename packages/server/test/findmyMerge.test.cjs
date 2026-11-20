const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const babel = require("@babel/core");

const loadTs = (relPath, overrides = {}) => {
    const absPath = path.resolve(__dirname, "..", relPath);
    const transformed = babel.transformFileSync(absPath, {
        presets: [
            [require.resolve("@babel/preset-env"), { targets: { node: "20" }, modules: "commonjs" }],
            require.resolve("@babel/preset-typescript")
        ]
    });
    const mod = { exports: {} };
    const fn = new Function("module", "exports", "require", transformed.code);
    const customRequire = req => (Object.prototype.hasOwnProperty.call(overrides, req) ? overrides[req] : require(req));
    fn(mod, mod.exports, customRequire);
    return mod.exports;
};

const createHarness = (opts = {}) => {
    const config = {
        enable_utag: opts.enableUtag ?? true,
        enable_gfind: opts.enableGfind ?? true
    };
    let appleCache = opts.appleDevices ?? [{ id: "apple-1", name: "MacBook Pro" }];
    let utagDevices = opts.utagDevices ?? [{ id: "utag:tag1", name: "SmartTag2" }];
    let gfindDevices = opts.gfindDevices ?? [{ id: "gfind:spot1", name: "Moto Tag" }];
    const calls = { appleRefresh: 0, utagRefresh: [], gfindRefresh: [], utagRing: [], gfindRing: [] };

    const mockServer = {
        repo: { getConfig: key => config[key] },
        findMyDevicesCache: {
            getAll: () => appleCache,
            replaceAll: next => {
                appleCache = next;
            }
        },
        findMyFriendsCache: { getAll: () => [] },
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        emitMessage: async () => {}
    };

    const { FindMyInterface } = loadTs("src/server/api/interfaces/findMyInterface.ts", {
        "@server": { Server: () => mockServer },
        "@server/api/lib/findmy/findMyIcons": {
            enrichFindMyDeviceIcon: d => d,
            findDeviceForIconLookup: (devices, id) => devices.find(d => d.id === id) ?? null,
            resolveFindMyDeviceIconBytes: async () => null
        },
        "@server/fileSystem": { FileSystem: { findMyDir: "/tmp/nonexistent", execShellCommand: async () => "" } },
        "@server/events": { NEW_FINDMY_DEVICE: "new-findmy-device" },
        "@server/env": { isMinBigSur: true, isMinSequoia: true, isMinSonoma: true },
        "@server/helpers/utils": { waitMs: async () => {} },
        "../apple/scripts": {
            quitFindMyFriends: () => "",
            startFindMyFriends: () => "",
            showFindMyFriends: () => "",
            hideFindMyFriends: () => ""
        },
        "@server/api/lib/findmy/utils": {
            getChangedFindMyDevices: () => [],
            normalizeFindMyFriendLocations: x => x,
            refreshFindMyDevicesThroughPrivateApi: async deps => {
                calls.appleRefresh += 1;
                if (opts.appleShouldFail) throw new Error("Apple helper offline");
                deps.server.findMyDevicesCache.replaceAll(opts.appleNext ?? [{ id: "apple-2", name: "iPhone" }]);
                return deps.server.findMyDevicesCache.getAll();
            },
            refreshFindMyFriends: async () => [],
            startFindMyLiveLocation: async () => ({ handle: "", live: false, locations: [] }),
            stopFindMyLiveLocation: async () => ({ handle: null, stopped: true }),
            transformFindMyItemToDevice: x => x
        },
        "@server/api/lib/findmy/privateApiSupport": {
            resolveFindMyDevicesPrivateApiTarget: () => null,
            resolveFindMyFriendsPrivateApiTarget: () => null
        },
        "@server/api/lib/utag": {
            utagService: {
                getCachedDevices: () => utagDevices,
                refreshDevices: async target => {
                    calls.utagRefresh.push(target ?? null);
                    if (opts.utagShouldFail) throw new Error("uTag offline");
                    if (opts.utagNext) utagDevices = opts.utagNext;
                    return utagDevices;
                },
                ringDevice: async (id, action) => {
                    calls.utagRing.push({ id, action });
                },
                getBleSpec: id => ({ deviceId: id, provider: "utag", serviceUuid: "fd5a" })
            }
        },
        "@server/api/lib/gfind": {
            gfindService: {
                getCachedDevices: () => gfindDevices,
                refreshDevices: async target => {
                    calls.gfindRefresh.push(target ?? null);
                    if (opts.gfindShouldFail) throw new Error("gfind offline");
                    if (opts.gfindNext) gfindDevices = opts.gfindNext;
                    return gfindDevices;
                },
                ringDevice: async (id, action, component) => {
                    calls.gfindRing.push({ id, action, component });
                },
                getBleSpec: id => ({ deviceId: id, provider: "gfind", serviceUuid: "feaa" })
            }
        }
    });

    return { FindMyInterface, calls, config };
};

test("getDevices merges Apple, utag, and gfind and respects enable flags without clobbering", async () => {
    const { FindMyInterface, config } = createHarness();
    const merged = await FindMyInterface.getDevices();
    assert.deepEqual(
        merged.map(d => d.id),
        ["apple-1", "utag:tag1", "gfind:spot1"]
    );

    // Full refresh replaces Apple cache via replaceAll, but utag & gfind remain merged
    const afterRefresh = await FindMyInterface.refreshDevices();
    assert.deepEqual(
        afterRefresh.map(d => d.id),
        ["apple-2", "utag:tag1", "gfind:spot1"]
    );

    config.enable_utag = false;
    const onlyAppleAndGfind = await FindMyInterface.getDevices();
    assert.deepEqual(
        onlyAppleAndGfind.map(d => d.id),
        ["apple-2", "gfind:spot1"]
    );
});

test("refreshDevices routes targeted utag: and gfind: refreshes directly", async () => {
    const { FindMyInterface, calls } = createHarness();

    await FindMyInterface.refreshDevices({ deviceId: "utag:tag1" });
    assert.equal(calls.appleRefresh, 0);
    assert.deepEqual(calls.utagRefresh, ["utag:tag1"]);
    assert.deepEqual(calls.gfindRefresh, []);

    await FindMyInterface.refreshDevices({ deviceId: "gfind:spot1" });
    assert.equal(calls.appleRefresh, 0);
    assert.deepEqual(calls.gfindRefresh, ["gfind:spot1"]);

    // M4: Apple-targeted refresh must not trigger utag or gfind refreshes
    calls.utagRefresh.length = 0;
    calls.gfindRefresh.length = 0;
    await FindMyInterface.refreshDevices({ deviceId: "apple-1" });
    assert.equal(calls.appleRefresh, 1);
    assert.deepEqual(calls.utagRefresh, []);
    assert.deepEqual(calls.gfindRefresh, []);
});

test("full refresh uses Promise.allSettled so offline Apple helper does not fail trackers", async () => {
    const { FindMyInterface, calls } = createHarness({
        appleShouldFail: true,
        utagNext: [{ id: "utag:tag1", name: "SmartTag2 Updated" }],
        gfindNext: [{ id: "gfind:spot1", name: "Moto Tag Updated" }]
    });

    const devices = await FindMyInterface.refreshDevices();
    assert.equal(calls.appleRefresh, 1);
    assert.deepEqual(calls.utagRefresh, [null]);
    assert.deepEqual(calls.gfindRefresh, [null]);
    assert.equal(devices.find(d => d.id === "utag:tag1")?.name, "SmartTag2 Updated");
    assert.equal(devices.find(d => d.id === "gfind:spot1")?.name, "Moto Tag Updated");
});

test("ringDevice and getBleSpec route by prefix and reject invalid or disabled targets", async () => {
    const { FindMyInterface, calls, config } = createHarness();

    await FindMyInterface.ringDevice("utag:tag1", "start");
    await FindMyInterface.ringDevice("gfind:spot1", "start", "left");
    assert.deepEqual(calls.utagRing, [{ id: "utag:tag1", action: "start" }]);
    assert.deepEqual(calls.gfindRing, [{ id: "gfind:spot1", action: "start", component: "left" }]);

    assert.equal(FindMyInterface.getBleSpec("utag:tag1").serviceUuid, "fd5a");
    assert.equal(FindMyInterface.getBleSpec("gfind:spot1").serviceUuid, "feaa");

    await assert.rejects(() => FindMyInterface.ringDevice("apple-1", "start"), /Unsupported deviceId/);
    assert.throws(() => FindMyInterface.getBleSpec("apple-1"), /Unsupported deviceId/);

    config.enable_gfind = false;
    await assert.rejects(() => FindMyInterface.ringDevice("gfind:spot1", "stop"), /disabled/);
});
