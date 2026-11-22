import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const SERVER_SRC_ROOT = path.resolve(import.meta.dirname, "../src/server");

const loadTsModule = (relPathFromServerSrc: string, overrides: Record<string, any> = {}): any => {
    const absPath = path.resolve(SERVER_SRC_ROOT, relPathFromServerSrc);
    const source = fs.readFileSync(absPath, "utf8");
    const { outputText } = ts.transpileModule(source, {
        fileName: absPath,
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true
        }
    });
    const mod = { exports: {} };
    const fn = new Function("module", "exports", "require", outputText);
    const customRequire = (req: string) => {
        if (Object.prototype.hasOwnProperty.call(overrides, req)) return overrides[req];
        return require(req);
    };
    fn(mod, mod.exports, customRequire);
    return mod.exports;
};

const createTransactionPromiseMock = () => {
    class MockTransactionPromise {
        type: string;
        isResolved = false;
        rejectedReason: unknown = null;
        constructor(type: string) {
            this.type = type;
        }
        reject(reason?: unknown) {
            this.isResolved = true;
            this.rejectedReason = reason;
        }
    }
    return { TransactionPromise: MockTransactionPromise, TransactionType: { FIND_MY: "FIND_MY" } };
};

test("PrivateApiFindMy.refreshDevices forwards deviceId and force and omits empty options", async () => {
    const sent: Array<{ action: string; data: any; target: string }> = [];
    const { PrivateApiFindMy } = loadTsModule("api/privateApi/apis/PrivateApiFindMy.ts", {
        ".": {
            PrivateApiAction: class {
                async sendApiMessage(action: string, data: any, _tx: any, target: string) {
                    sent.push({ action, data, target });
                    return { data: { devices: [], partial: false, skippedDevices: 0 } };
                }
            }
        },
        "@server/managers/transactionManager/transactionPromise": createTransactionPromiseMock(),
        "@server/env": { isMinBigSur: true, isMinSonoma: true, isMinSequoia: true },
        "@server/api/lib/findmy/privateApiSupport": loadTsModule("api/lib/findmy/privateApiSupport.ts")
    });

    const api = new PrivateApiFindMy();
    await api.refreshDevices();
    await api.refreshDevices({ deviceId: "   " });
    await api.refreshDevices({ deviceId: " dev-123 ", force: true });
    await api.refreshDevices({ force: false });

    assert.deepEqual(sent, [
        { action: "refresh-findmy-devices", data: null, target: "com.apple.findmy" },
        { action: "refresh-findmy-devices", data: null, target: "com.apple.findmy" },
        {
            action: "refresh-findmy-devices",
            data: { deviceId: "dev-123", force: true },
            target: "com.apple.findmy"
        },
        { action: "refresh-findmy-devices", data: { force: false }, target: "com.apple.findmy" }
    ]);
});

test("PrivateApiFindMy.refreshDevices accommodates 8s helper poll and times out at 12s", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const transactions: any[] = [];
    let pendingResolver: ((value: any) => void) | null = null;

    const { PrivateApiFindMy, FIND_MY_DEVICES_REFRESH_TIMEOUT_MS } = loadTsModule(
        "api/privateApi/apis/PrivateApiFindMy.ts",
        {
            ".": {
                PrivateApiAction: class {
                    sendApiMessage(_action: string, _data: any, tx: any) {
                        transactions.push(tx);
                        return new Promise(resolve => {
                            pendingResolver = resolve;
                        });
                    }
                }
            },
            "@server/managers/transactionManager/transactionPromise": createTransactionPromiseMock(),
            "@server/env": { isMinBigSur: true, isMinSonoma: true, isMinSequoia: true },
            "@server/api/lib/findmy/privateApiSupport": loadTsModule("api/lib/findmy/privateApiSupport.ts")
        }
    );

    assert.equal(FIND_MY_DEVICES_REFRESH_TIMEOUT_MS, 12_000);
    const api = new PrivateApiFindMy();

    // 8s active poll finishes well inside the 12s timeout window.
    const slowSuccess = api.refreshDevices({ deviceId: "dev-1", force: true });
    t.mock.timers.tick(8_000);
    pendingResolver!({ data: { devices: [{ identifier: "dev-1" }], partial: false, skippedDevices: 0 } });
    const res = await slowSuccess;
    assert.equal(res.data.devices.length, 1);
    assert.equal(transactions[0].isResolved, false);

    // Hung helper times out cleanly at 12s and marks transaction resolved.
    const hungRefresh = api.refreshDevices({ deviceId: "dev-2", force: true });
    t.mock.timers.tick(12_000);
    await assert.rejects(hungRefresh, /timed out after 12000ms/);
    assert.equal(transactions[1].isResolved, true);
});

test("FindMyInterface.refreshDevices and FindMyRouter.refreshDevices forward deviceId and force cleanly", async () => {
    const helperCalls: Array<{ options: any; target: string }> = [];
    let cachedDevices: any[] = [];
    const deviceRecord = {
        id: "dev-1",
        identifier: "dev-1",
        name: "iPhone",
        location: { latitude: 37.33, longitude: -122.03, timeStamp: 1700000001000 }
    };

    const mockServer = {
        repo: { getConfig: (key: string) => key === "enable_private_api" || key === "open_findmy_on_startup" },
        privateApi: {
            hasClient: () => true,
            findmy: {
                refreshDevices: async (options: any) => {
                    helperCalls.push({ options, target: "com.apple.findmy" });
                    return { data: { devices: [deviceRecord], partial: false, skippedDevices: 0 } };
                }
            }
        },
        findMyDevicesCache: {
            getAll: () => cachedDevices,
            updateAll: (items: any[]) => {
                cachedDevices = items;
                return items;
            },
            replaceAll: (items: any[]) => {
                cachedDevices = items;
                return items;
            }
        },
        findMyFriendsCache: { getAll: () => [] },
        emitMessage: async () => undefined,
        logger: { debug: () => undefined, warn: () => undefined }
    };

    const findMyUtils = loadTsModule("api/lib/findmy/findMyForkHelpers.ts");
    const privateApiSupport = loadTsModule("api/lib/findmy/privateApiSupport.ts");

    const { FindMyInterface } = loadTsModule("api/interfaces/findMyInterface.ts", {
        "@server": { Server: () => mockServer },
        "@server/fileSystem": { FileSystem: { findMyDir: "/tmp/nonexistent", execShellCommand: async () => "" } },
        "@server/events": { NEW_FINDMY_DEVICE: "new-findmy-device" },
        "@server/env": { isMinBigSur: true, isMinSonoma: true, isMinSequoia: true },
        "@server/helpers/utils": { waitMs: async () => undefined },
        "../apple/scripts": {
            quitFindMyFriends: () => "",
            startFindMyFriends: () => "",
            showFindMyFriends: () => "",
            hideFindMyFriends: () => ""
        },
        "@server/api/lib/findmy/types": {},
        "@server/api/lib/utag": { utagService: { getCachedDevices: () => [], refreshDevices: async () => [] } },
        "@server/api/lib/gfind": { gfindService: { getCachedDevices: () => [], refreshDevices: async () => [] } },
        "@server/api/lib/findmy/findMyIcons": {
            enrichFindMyDeviceIcon: (d: any) => d,
            findDeviceForIconLookup: () => null,
            resolveFindMyDeviceIconBytes: async () => null
        },
        "@server/api/lib/findmy/utils": findMyUtils,
        "@server/api/lib/findmy/privateApiSupport": privateApiSupport
    });

    const { FindMyRouter } = loadTsModule("api/http/api/v1/routers/findmyRouter.ts", {
        koa: {},
        "koa-router": {},
        "../responses/success": {
            Success: class {
                payload: any;
                constructor(_ctx: any, payload: any) {
                    this.payload = payload;
                }
                send() {
                    return this.payload;
                }
            }
        },
        "../responses/errors": { BadRequest: Error, ServerError: Error },
        "@server/api/interfaces/findMyInterface": { FindMyInterface },
        "@server/api/lib/findmy/types": {},
        "@server/events": { NEW_FINDMY_LOCATION: "new-findmy-location" },
        "@server": { Server: () => mockServer }
    });

    // Existing untargeted caller with empty body/query passes undefined.
    await FindMyRouter.refreshDevices({ request: { body: {} }, query: {} }, async () => {});
    // Body parameters forward deviceId + force cleanly.
    await FindMyRouter.refreshDevices(
        { request: { body: { deviceId: " dev-1 ", force: true } }, query: {} },
        async () => {}
    );
    // Query parameters forward deviceId + force cleanly.
    await FindMyRouter.refreshDevices(
        { request: { body: {} }, query: { deviceId: "dev-2", force: "true" } },
        async () => {}
    );
    // Direct interface call normalizes whitespace-only deviceId.
    await FindMyInterface.refreshDevices({ deviceId: "   ", force: false });

    assert.deepEqual(
        helperCalls.map(c => c.options),
        [undefined, { deviceId: "dev-1", force: true }, { deviceId: "dev-2", force: true }, { force: false }]
    );
});
