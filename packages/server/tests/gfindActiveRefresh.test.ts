import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const require = createRequire(import.meta.url);

require.extensions[".ts"] = function (module: any, filename: string) {
    const source = fs.readFileSync(filename, "utf8");
    const { outputText } = ts.transpileModule(source, {
        fileName: filename,
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
            experimentalDecorators: true,
            emitDecoratorMetadata: true
        }
    });
    return module._compile(outputText, filename);
};

const origResolveFilename = (Module as any)._resolveFilename;
const serverRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src/server");
(Module as any)._resolveFilename = function (request: string, parent: any, isMain: boolean, options: any) {
    if (request === "@server") {
        return origResolveFilename.call(this, path.join(serverRoot, "index.ts"), parent, isMain, options);
    }
    if (request.startsWith("@server/")) {
        return origResolveFilename.call(
            this,
            path.join(serverRoot, request.slice("@server/".length)),
            parent,
            isMain,
            options
        );
    }
    return origResolveFilename.call(this, request, parent, isMain, options);
};

const { GoogleFindService } = require("../src/server/api/lib/gfind/gfindService.ts");
const { NovaDeviceType, SpotDeviceType } = require("../src/server/api/lib/gfind/gfindProto.ts");

function makeTrackerDeps(baseDir: string) {
    return {
        baseDir,
        safeStorage: {
            isEncryptionAvailable: () => true,
            encryptString: (s: string) => Buffer.from(s, "utf8"),
            decryptString: (b: Buffer) => b.toString("utf8")
        }
    };
}

function makeDeviceMeta(id: string, name: string, timestampSec?: number, accuracy = 25) {
    return {
        identifierInformation: {
            type: 2,
            phoneInformation: { canonicIds: [id] }
        },
        userDefinedDeviceName: name,
        information: {
            deviceRegistration: {
                deviceType: SpotDeviceType.DEVICE_TYPE_UNKNOWN
            },
            reports:
                timestampSec != null
                    ? [
                          {
                              timestampSeconds: timestampSec,
                              timestampNanos: 0,
                              status: 1,
                              geoLocation: {
                                  accuracy,
                                  unencryptedLocation: {
                                      latitude: 37.33,
                                      longitude: -122.03,
                                      accuracy
                                  }
                              }
                          }
                      ]
                    : []
        }
    };
}

function setupService(baseDir: string) {
    const trackerDeps = makeTrackerDeps(baseDir);
    const service = new GoogleFindService({
        trackerDeps,
        reverseGeocodeFn: async () => null,
        emitDevice: () => undefined,
        isEnabled: () => true,
        locateTimeoutMs: 250,
        minLocateIntervalMs: 60_000,
        staggerDelayMs: 1,
        fcmPollIntervalMs: 10,
        fcmPollCapMs: 80
    });

    const auth = (service as any).auth;
    auth.load();
    auth.state.email = "user@example.com";
    auth.state.aasToken = "aas-token";
    auth.state.fcmToken = "fcm-token";

    return service;
}

test("gfind handleFcmEvent ignores repCount===0 and stale timestamps, resolves only on fresher timestamp or better accuracy", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfind-test-"));
    try {
        const service = setupService(tmpDir);
        const locateRequests: string[] = [];

        (service as any).fcm.isConnected = () => true;
        (service as any).client.listDevices = async () => [makeDeviceMeta("dev-1", "Pixel", 1000, 30)];
        (service as any).client.locateDevice = async (req: any) => {
            locateRequests.push(req.requestUuid);
        };

        // Seed baseline record at ts=1000s, accuracy=30
        await service.refreshDevices();
        locateRequests.length = 0;

        // Start targeted locate; push repCount===0, then stale ts=900s, then fresher ts=1010s
        const refreshPromise = service.refreshDevices("gfind:dev-1", { force: true });
        await new Promise(r => setTimeout(r, 15));
        assert.equal(locateRequests.length, 1);
        const reqUuid = locateRequests[0];

        // 1) repCount === 0 should NOT resolve waiter
        await (service as any).handleFcmEvent({
            deviceUpdate: {
                fcmMetadata: { requestUuid: reqUuid },
                deviceMetadata: makeDeviceMeta("dev-1", "Pixel")
            }
        });
        assert.equal((service as any).pendingWaiters.size, 1);

        // 2) Stale timestamp (900 < 1000) should NOT resolve waiter
        await (service as any).handleFcmEvent({
            deviceUpdate: {
                fcmMetadata: { requestUuid: reqUuid },
                deviceMetadata: makeDeviceMeta("dev-1", "Pixel", 900, 5)
            }
        });
        assert.equal((service as any).pendingWaiters.size, 1);

        // 3) Newer timestamp (1010 > 1000) MUST resolve waiter
        await (service as any).handleFcmEvent({
            deviceUpdate: {
                fcmMetadata: { requestUuid: reqUuid },
                deviceMetadata: makeDeviceMeta("dev-1", "Pixel", 1010, 20)
            }
        });
        const devices = await refreshPromise;
        assert.equal((service as any).pendingWaiters.size, 0);
        assert.equal(devices[0]?.last_updated, 1010 * 1000);

        // 4) Same timestamp (1010) with improved accuracy (10 < 20) MUST also resolve waiter
        const refreshPromise2 = service.refreshDevices("gfind:dev-1", { force: true });
        await new Promise(r => setTimeout(r, 15));
        const reqUuid2 = locateRequests[1];
        await (service as any).handleFcmEvent({
            deviceUpdate: {
                fcmMetadata: { requestUuid: reqUuid2 },
                deviceMetadata: makeDeviceMeta("dev-1", "Pixel", 1010, 10)
            }
        });
        const devices2 = await refreshPromise2;
        assert.equal((service as any).pendingWaiters.size, 0);
        assert.equal(devices2[0]?.location?.horizontalAccuracy, 10);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("gfind untargeted force:true triggers staggered locateDevice calls with bounded wait", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfind-test-"));
    try {
        const service = setupService(tmpDir);
        const locatedIds: string[] = [];

        (service as any).fcm.isConnected = () => true;
        (service as any).client.listDevices = async () => [
            makeDeviceMeta("dev-1", "Pixel", 1000),
            makeDeviceMeta("dev-2", "Keys", 1000)
        ];
        (service as any).client.locateDevice = async (req: any) => {
            locatedIds.push(req.canonicId);
        };

        // First call populates lastLocateAt
        await service.refreshDevices();
        assert.deepEqual(locatedIds, ["dev-1", "dev-2"]);
        locatedIds.length = 0;

        // Second untargeted call WITH force:true must bypass minLocateIntervalMs and trigger staggered locates
        const start = Date.now();
        await service.refreshDevices(undefined, { force: true });
        const elapsed = Date.now() - start;

        assert.deepEqual(locatedIds, ["dev-1", "dev-2"]);
        // Bounded by locateTimeoutMs (250ms) even with no FCM replies
        assert.ok(elapsed < 1000, `expected bounded wait, got ${elapsed}ms`);
        assert.equal((service as any).pendingWaiters.size, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("gfind falls back to polling listDevices when FCM is disconnected until fresher data arrives", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gfind-test-"));
    try {
        const service = setupService(tmpDir);
        let listCalls = 0;
        let locateCalls = 0;

        (service as any).fcm.isConnected = () => false;
        (service as any).fcm.ensureReady = async () => null;
        (service as any).client.locateDevice = async () => {
            locateCalls += 1;
        };
        (service as any).client.listDevices = async () => {
            listCalls += 1;
            // Seed at 1000s; first poll still 1000s; second poll returns fresher 1020s
            const ts = listCalls >= 3 ? 1020 : 1000;
            return [makeDeviceMeta("dev-1", "Pixel", ts)];
        };

        // Initial seed (listCalls=1)
        await service.refreshDevices();
        listCalls = 0;
        locateCalls = 0;

        // Targeted refresh with FCM disconnected: calls locateDevice, then polls listDevices until ts=1020
        const devices = await service.refreshDevices("gfind:dev-1", { force: true });
        assert.equal(locateCalls, 1);
        assert.ok(listCalls >= 3, `expected >= 3 poll listDevices calls, got ${listCalls}`);
        assert.equal(devices[0]?.last_updated, 1020 * 1000);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
